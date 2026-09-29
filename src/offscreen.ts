// Offscreen document: owns the tab/microphone capture, voice-activity detection
// and segment recording. The tab (everyone else) and the microphone (the person
// recording) are separate channels: each is segmented at its own pauses and
// transcribed on its own, so every microphone line is the recording user and
// overlapping speech is not lost. Each segment is recorded by its own
// MediaRecorder so every chunk is a complete, independently decodable file
// (issue #678), then handed to the service worker for transcription.

import { isChunkViable } from "./audioProcessing";
import { microphoneErrorCode } from "./microphoneErrors";
import { computeRms } from "./vadTuning";
import { SpeechSegmenter } from "./segmenter";
import {
  MAX_BUFFER_MS,
  MAX_PENDING_CHUNKS,
  MIN_SEGMENT_MS,
  SILENT_SEGMENT_DISCARD_MS,
  VAD_SAMPLE_MS,
  WAVEFORM_BUCKETS,
  WAVEFORM_GAIN,
  WAVEFORM_INTERVAL_MS,
} from "./config";
import {
  createMicrophoneChannelGraph,
  createTabChannelGraph,
  MICROPHONE_AUDIO_CONSTRAINTS,
  type CaptureChannelGraph,
} from "./offscreenAudioGraph";

type ChannelId = "tab" | "mic";

interface PendingChunk {
  blob: Blob;
  source: ChannelId;
  startedAt: number;
  endedAt: number;
  attempts: number;
}

interface Channel {
  id: ChannelId;
  input: MediaStream;
  graph: CaptureChannelGraph;
  buffer: Uint8Array<ArrayBuffer>;
  recorder: MediaRecorder | null;
  segmenter: SpeechSegmenter;
  rotation: Promise<void> | null;
  /** Mic muted in Meet: its audio is not part of the meeting and is dropped. */
  muted: boolean;
}

type SegmentMode = "send" | "discard";

const DEFAULT_RMS_THRESHOLD = 0.012;
/** Back-pressure: wait this long before re-offering a chunk the SW queue rejected. */
const REJECTED_CHUNK_RETRY_MS = 1500;
/** Give up on a chunk the SW keeps rejecting after this many offers (~45 s). */
const MAX_CHUNK_OFFERS = 30;
/** Upper bound for the final drain on stop, so a wedged SW can't hang the stop. */
const STOP_DRAIN_TIMEOUT_MS = 90_000;
/** While the mic is muted in Meet, its recording is restarted (dropped) this often. */
const MUTED_DISCARD_MS = 2000;

let channels: Channel[] = [];
let audioContext: AudioContext | null = null;
let vadTimer: ReturnType<typeof setInterval> | null = null;
let waveformTimer: ReturnType<typeof setInterval> | null = null;
let recorderMimeType = "";
let rmsThreshold = DEFAULT_RMS_THRESHOLD;
let micMutedInMeet = false;

let pendingChunks: PendingChunk[] = [];
let drainPromise: Promise<void> | null = null;
let stopPromise: Promise<void> | null = null;
let captureActive = false;
let chunksSent = 0;
let chunksDropped = 0;
let segmentsDiscarded = 0;

// Forwards a log line to the service worker console (chrome://extensions →
// service worker), which is easier to open than the offscreen DevTools.
function relay(message: string) {
  console.log(`[ValorBrainMeet][offscreen] ${message}`);
  chrome.runtime.sendMessage({ type: "OFFSCREEN_LOG", message }).catch(() => {});
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed to read blob"));
    reader.onabort = () => reject(new Error("FileReader read was aborted"));
    reader.readAsDataURL(blob);
  });
}

function pickSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function channelLabel(channel: Channel): string {
  return channel.id === "mic" ? "microfone" : "aba";
}

function readRms(channel: Channel): number {
  channel.graph.analyser.getByteTimeDomainData(channel.buffer);
  return computeRms(channel.buffer);
}

function sampleAndSendWaveform() {
  if (!captureActive || channels.length === 0) return;

  // One bar graph for the meeting: the louder of the two channels per bucket.
  const buckets = new Array<number>(WAVEFORM_BUCKETS).fill(0);
  for (const channel of channels) {
    if (channel.muted) continue;
    const buffer = channel.buffer;
    channel.graph.analyser.getByteTimeDomainData(buffer);
    const bucketSize = Math.floor(buffer.length / WAVEFORM_BUCKETS);
    for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
      let sum = 0;
      for (let j = 0; j < bucketSize; j++) {
        sum += Math.abs((buffer[i * bucketSize + j] - 128) / 128);
      }
      buckets[i] = Math.max(buckets[i], Math.min(1, (sum / bucketSize) * WAVEFORM_GAIN));
    }
  }

  chrome.runtime.sendMessage({ type: "WAVEFORM_DATA", buckets }).catch(() => {});
}

/** Creates a recorder for the channel's own recording stream (one per segment). */
function createRecorder(channel: Channel): MediaRecorder {
  const stream = channel.graph.destination.stream;
  const recorder = recorderMimeType
    ? new MediaRecorder(stream, { mimeType: recorderMimeType })
    : new MediaRecorder(stream);
  recorder.addEventListener("error", handleRecorderError);
  return recorder;
}

/**
 * Stops `recorder` and resolves with its final blob. Per the MediaStream
 * Recording spec the order is `dataavailable` → `stop`; a timeout guards
 * against the events never firing.
 */
function stopRecorderAndCollect(recorder: MediaRecorder): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve(null);
      return;
    }
    const parts: Blob[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      recorder.removeEventListener("dataavailable", onData);
      recorder.removeEventListener("stop", onStop);
      recorder.removeEventListener("error", handleRecorderError);
      const type = recorder.mimeType || recorderMimeType || "audio/webm";
      resolve(parts.length > 0 ? new Blob(parts, { type }) : null);
    };
    const onData = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) parts.push(event.data);
    };
    const onStop = () => finish();
    const timeoutId = setTimeout(() => {
      relay("recorder stop timeout — using the data collected so far");
      finish();
    }, 3000);

    recorder.addEventListener("dataavailable", onData);
    recorder.addEventListener("stop", onStop, { once: true });
    try {
      recorder.stop();
    } catch (err) {
      console.error("[ValorBrainMeet][offscreen] recorder stop failed:", err);
      finish();
    }
  });
}

/**
 * Ends the channel's current segment and immediately starts the next one. The
 * new recorder starts before the old one stops, so consecutive segments
 * overlap by a few milliseconds instead of leaving a gap.
 */
function rotateSegment(channel: Channel, mode: SegmentMode, reason: string): Promise<void> {
  if (channel.rotation) return channel.rotation;
  channel.rotation = (async () => {
    const previous = channel.recorder;
    const startedAt = channel.segmenter.segmentStartedAt;
    const endedAt = Date.now();
    if (!previous) return;

    try {
      channel.recorder = createRecorder(channel);
      channel.recorder.start();
      channel.segmenter.reset(endedAt);
    } catch (err) {
      relay(`recorder restart failed — ${(err as Error)?.message ?? "unknown error"}`);
      channel.recorder = null;
      void failCapture("O gravador de áudio parou de responder.");
      return;
    }

    const blob = await stopRecorderAndCollect(previous);
    if (mode === "discard") {
      segmentsDiscarded += 1;
      return;
    }
    if (!blob || !isChunkViable(blob)) {
      relay(`${channel.id} segment skipped (${reason}) — ${blob?.size ?? 0} bytes`);
      return;
    }
    relay(
      `${channel.id} segment ready (${reason}) — ${blob.size} bytes, ${Math.round((endedAt - startedAt) / 1000)}s`,
    );
    enqueueChunk({ blob, source: channel.id, startedAt, endedAt, attempts: 0 });
  })().finally(() => {
    channel.rotation = null;
  });
  return channel.rotation;
}

function enqueueChunk(chunk: PendingChunk) {
  pendingChunks.push(chunk);
  while (pendingChunks.length > MAX_PENDING_CHUNKS) {
    // Never grow without bound if the SW is gone for good: drop the oldest.
    pendingChunks.shift();
    chunksDropped += 1;
    relay(`pending chunk cap (${MAX_PENDING_CHUNKS}) reached — dropped the oldest segment`);
  }
  void drainPendingChunks();
}

type OfferResult = "accepted" | "rejected" | "failed";

async function offerChunk(chunk: PendingChunk): Promise<OfferResult> {
  try {
    const audioBase64 = await blobToBase64(chunk.blob);
    const response = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_AUDIO_CHUNK",
      audioBase64,
      mimeType: chunk.blob.type || recorderMimeType || "audio/webm",
      source: chunk.source,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
    });
    if (response?.success) return "accepted";
    if (response?.pauseRecorder) return "rejected";
    relay(`chunk refused by the service worker — ${response?.error || "unknown error"}`);
    return "failed";
  } catch (err) {
    console.error("[ValorBrainMeet][offscreen] failed to send chunk:", err);
    return "rejected";
  }
}

/** Posts queued chunks in order, re-offering the head while the SW is saturated. */
function drainPendingChunks(): Promise<void> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    while (pendingChunks.length > 0) {
      const chunk = pendingChunks[0];
      const result = await offerChunk(chunk);
      if (result === "accepted") {
        pendingChunks.shift();
        chunksSent += 1;
        continue;
      }
      if (result === "failed") {
        pendingChunks.shift();
        chunksDropped += 1;
        continue;
      }
      chunk.attempts += 1;
      if (chunk.attempts >= MAX_CHUNK_OFFERS) {
        pendingChunks.shift();
        chunksDropped += 1;
        relay("service worker kept rejecting a segment — dropped it");
        continue;
      }
      await sleep(REJECTED_CHUNK_RETRY_MS);
    }
  })().finally(() => {
    drainPromise = null;
  });
  return drainPromise;
}

/** Drains pending chunks but gives up after `ms` (the timer is always cleared). */
async function drainWithDeadline(ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([drainPendingChunks(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function vadTick() {
  if (!captureActive) return;
  const now = Date.now();
  for (const channel of channels) {
    if (channel.rotation || !channel.recorder) continue;
    if (channel.muted) {
      // Muted in Meet: nobody in the call hears it, so it is not recorded.
      if (now - channel.segmenter.segmentStartedAt >= MUTED_DISCARD_MS) {
        void rotateSegment(channel, "discard", "microfone mudo no Meet");
      }
      continue;
    }
    const decision = channel.segmenter.tick(readRms(channel), now);
    if (decision.action !== "continue") {
      void rotateSegment(channel, decision.action, decision.reason);
    }
  }
}

function stopTracks(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function cleanupResources() {
  captureActive = false;
  if (vadTimer) clearInterval(vadTimer);
  if (waveformTimer) clearInterval(waveformTimer);
  vadTimer = null;
  waveformTimer = null;

  for (const channel of channels) {
    stopTracks(channel.input);
    stopTracks(channel.graph.destination.stream);
  }
  channels = [];

  if (audioContext) {
    try {
      await audioContext.close();
    } catch (err) {
      console.warn("[ValorBrainMeet][offscreen] AudioContext close failed:", err);
    }
    audioContext = null;
  }
}

async function getTabAudioStream(streamId: string) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error Chrome-specific tab capture constraints
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
}

let microphoneError: string | null = null;

async function getMicrophoneStream() {
  microphoneError = null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: MICROPHONE_AUDIO_CONSTRAINTS,
      video: false,
    });
  } catch (err) {
    const e = err as DOMException;
    // "SystemDenied" when macOS/Windows privacy settings block Chrome itself.
    microphoneError = microphoneErrorCode(err);
    relay(`microphone unavailable — ${e?.name}: ${e?.message}`);
    return null;
  }
}

async function handleRecorderError(event: Event) {
  console.error("[ValorBrainMeet][offscreen] recorder error:", event);
  await failCapture("O gravador de áudio falhou.");
}

/** Ends capture after an unrecoverable problem and tells the service worker why. */
async function failCapture(reason: string) {
  if (!captureActive && !stopPromise) return;
  await stopCapture();
  await chrome.runtime.sendMessage({ type: "UNEXPECTED_TRACK_END", reason }).catch(() => {});
}

function createChannel(id: ChannelId, input: MediaStream, graph: CaptureChannelGraph): Channel {
  const now = Date.now();
  const channel: Channel = {
    id,
    input,
    graph,
    // Sized once per capture and reused by every VAD/waveform read.
    buffer: new Uint8Array(new ArrayBuffer(graph.analyser.fftSize)),
    recorder: null,
    segmenter: new SpeechSegmenter({
      tickMs: VAD_SAMPLE_MS,
      minSegmentMs: MIN_SEGMENT_MS,
      maxSegmentMs: MAX_BUFFER_MS,
      silentDiscardMs: SILENT_SEGMENT_DISCARD_MS,
      baseThreshold: rmsThreshold,
    }),
    rotation: null,
    muted: id === "mic" && micMutedInMeet,
  };
  channel.recorder = createRecorder(channel);
  channel.recorder.start();
  channel.segmenter.reset(now);
  return channel;
}

/** Closes a channel whose input ended, keeping its last segment if it held speech. */
async function closeChannel(channel: Channel) {
  channels = channels.filter((candidate) => candidate !== channel);
  if (channel.rotation) await channel.rotation;
  const recorder = channel.recorder;
  channel.recorder = null;
  if (!recorder) return;
  const startedAt = channel.segmenter.segmentStartedAt;
  const keep = channel.segmenter.hasSpeech() && !channel.muted;
  const blob = await stopRecorderAndCollect(recorder);
  if (keep && blob && isChunkViable(blob)) {
    enqueueChunk({ blob, source: channel.id, startedAt, endedAt: Date.now(), attempts: 0 });
  }
  stopTracks(channel.graph.destination.stream);
}

async function startCapture(streamId: string, includeMicrophone = true, vadThreshold?: number) {
  if (captureActive && channels.some((channel) => channel.recorder?.state === "recording")) {
    return {
      microphoneActive: channels.some((channel) => channel.id === "mic"),
      alreadyActive: true,
    };
  }
  if (stopPromise) await stopPromise;

  // Offscreen documents cannot read chrome.storage; the SW forwards the threshold.
  rmsThreshold =
    typeof vadThreshold === "number" && Number.isFinite(vadThreshold) && vadThreshold > 0
      ? vadThreshold
      : DEFAULT_RMS_THRESHOLD;
  chunksSent = 0;
  chunksDropped = 0;
  segmentsDiscarded = 0;
  pendingChunks = [];
  channels = [];

  const tabStream = await getTabAudioStream(streamId);
  if (!tabStream) throw new Error("Não foi possível capturar o áudio da aba.");

  tabStream.getTracks().forEach((track) => {
    track.onended = () => {
      if (!captureActive) return;
      relay("tab audio track ended (tab closed or capture revoked)");
      void failCapture(
        "A captura da aba foi encerrada (aba fechada ou compartilhamento interrompido).",
      );
    };
  });

  audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();

  recorderMimeType = pickSupportedMimeType();
  channels.push(createChannel("tab", tabStream, createTabChannelGraph(audioContext, tabStream)));

  if (includeMicrophone) {
    const microphoneStream = await getMicrophoneStream();
    if (microphoneStream) {
      const mic = createChannel(
        "mic",
        microphoneStream,
        createMicrophoneChannelGraph(audioContext, microphoneStream),
      );
      channels.push(mic);
      microphoneStream.getTracks().forEach((track) => {
        track.onended = () => {
          if (!captureActive) return;
          relay("microphone track ended (input device disconnected)");
          void closeChannel(mic);
          chrome.runtime.sendMessage({ type: "OFFSCREEN_MIC_LOST" }).catch(() => {});
        };
      });
    }
  }

  captureActive = true;
  waveformTimer = setInterval(sampleAndSendWaveform, WAVEFORM_INTERVAL_MS);
  vadTimer = setInterval(vadTick, VAD_SAMPLE_MS);

  const microphoneActive = channels.some((channel) => channel.id === "mic");
  relay(
    `capture started — channels=${channels.map(channelLabel).join("+")} mime=${recorderMimeType || "default"} rmsThreshold=${rmsThreshold}`,
  );
  return { microphoneActive, microphoneError };
}

/** Meet's own mute button: while muted, the microphone channel records nothing. */
function setMicMuted(muted: boolean) {
  if (micMutedInMeet === muted) return;
  micMutedInMeet = muted;
  const mic = channels.find((channel) => channel.id === "mic");
  if (!mic) return;
  // Whatever was recorded around the switch is dropped: muted speech must not leak.
  mic.muted = muted;
  void rotateSegment(mic, "discard", muted ? "microfone mudo no Meet" : "microfone reativado");
  relay(`microphone ${muted ? "muted" : "unmuted"} in Meet`);
}

/**
 * Stops capture: records each channel's final segment (only if it holds
 * speech), posts every pending chunk to the service worker and releases the
 * devices. Concurrent callers share the same promise.
 */
function stopCapture(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    const wasActive = captureActive;
    captureActive = false;
    if (vadTimer) clearInterval(vadTimer);
    if (waveformTimer) clearInterval(waveformTimer);
    vadTimer = null;
    waveformTimer = null;

    try {
      await Promise.all(channels.map((channel) => channel.rotation ?? Promise.resolve()));
      const finals = channels.map(async (channel) => {
        const recorder = channel.recorder;
        channel.recorder = null;
        if (!wasActive || !recorder) return;
        const startedAt = channel.segmenter.segmentStartedAt;
        const keep = channel.segmenter.hasSpeech() && !channel.muted;
        const blob = await stopRecorderAndCollect(recorder);
        if (keep && blob && isChunkViable(blob)) {
          enqueueChunk({ blob, source: channel.id, startedAt, endedAt: Date.now(), attempts: 0 });
        }
      });
      await Promise.all(finals);
      await drainWithDeadline(STOP_DRAIN_TIMEOUT_MS);
      if (pendingChunks.length > 0) {
        chunksDropped += pendingChunks.length;
        relay(`stop drain timed out — ${pendingChunks.length} segment(s) not delivered`);
        pendingChunks = [];
      }
    } catch (err) {
      console.error("[ValorBrainMeet][offscreen] stopCapture failed:", err);
    } finally {
      await cleanupResources();
      relay(
        `capture stopped — sent=${chunksSent} dropped=${chunksDropped} silentSegments=${segmentsDiscarded}`,
      );
    }
  })().finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith("OFFSCREEN_")) return false;

  (async () => {
    switch (message.type) {
      case "OFFSCREEN_PING":
        sendResponse({ success: true, captureActive });
        return;

      case "OFFSCREEN_START_CAPTURE":
        try {
          micMutedInMeet = message.micMuted === true;
          const info = await startCapture(
            message.streamId,
            message.includeMicrophone !== false,
            message.vadThreshold,
          );
          sendResponse({ success: true, ...info });
        } catch (err) {
          await cleanupResources();
          const e = err as Error;
          console.error("[ValorBrainMeet][offscreen] failed to start capture:", e);
          sendResponse({ success: false, error: e?.message || "Falha ao iniciar a captura" });
        }
        return;

      case "OFFSCREEN_SET_MIC_MUTED":
        setMicMuted(message.muted === true);
        sendResponse({ success: true });
        return;

      case "OFFSCREEN_STOP_CAPTURE":
        await stopCapture();
        chrome.runtime.sendMessage({ type: "OFFSCREEN_CAPTURE_STOPPED" }).catch(() => {});
        sendResponse({
          success: true,
          drainComplete: pendingChunks.length === 0,
          chunksSent,
          chunksDropped,
          segmentsDiscarded,
        });
        return;

      default:
        // Messages addressed to the SW (OFFSCREEN_AUDIO_CHUNK, OFFSCREEN_LOG, ...)
        // are also delivered here; ignore them without answering.
        return;
    }
  })();

  return message.type === "OFFSCREEN_PING" ||
    message.type === "OFFSCREEN_START_CAPTURE" ||
    message.type === "OFFSCREEN_SET_MIC_MUTED" ||
    message.type === "OFFSCREEN_STOP_CAPTURE"
    ? true
    : false;
});
