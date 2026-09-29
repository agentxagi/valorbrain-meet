// Offscreen document: owns the tab/microphone capture, voice-activity detection
// and segment recording. Each speech segment is recorded by its own
// MediaRecorder so every chunk is a complete, independently decodable file
// (issue #678), then handed to the service worker for transcription.

import { isChunkViable } from "./audioProcessing";
import { computeRms } from "./vadTuning";
import {
  MAX_BUFFER_MS,
  MAX_PENDING_CHUNKS,
  MIN_SEGMENT_MS,
  SILENCE_FLUSH_MS,
  SILENT_SEGMENT_DISCARD_MS,
  VAD_SAMPLE_MS,
  WAVEFORM_BUCKETS,
  WAVEFORM_GAIN,
  WAVEFORM_INTERVAL_MS,
} from "./config";
import {
  connectMicrophoneToOffscreenAudioGraph,
  createOffscreenAudioGraph,
  MICROPHONE_AUDIO_CONSTRAINTS,
} from "./offscreenAudioGraph";

interface PendingChunk {
  blob: Blob;
  startedAt: number;
  endedAt: number;
  attempts: number;
}

type SegmentMode = "send" | "discard";

const DEFAULT_RMS_THRESHOLD = 0.012;
const SILENCE_FLUSH_TICKS = Math.ceil(SILENCE_FLUSH_MS / VAD_SAMPLE_MS);
/** A segment whose loudest tick stays below this fraction of the threshold is silence. */
const NEAR_SPEECH_FACTOR = 0.6;
/** Back-pressure: wait this long before re-offering a chunk the SW queue rejected. */
const REJECTED_CHUNK_RETRY_MS = 1500;
/** Give up on a chunk the SW keeps rejecting after this many offers (~45 s). */
const MAX_CHUNK_OFFERS = 30;
/** Upper bound for the final drain on stop, so a wedged SW can't hang the stop. */
const STOP_DRAIN_TIMEOUT_MS = 90_000;

let mediaStream: MediaStream | null = null;
let microphoneStream: MediaStream | null = null;
let recorderStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let analysisBuffer: Uint8Array<ArrayBuffer> | null = null;
let vadTimer: ReturnType<typeof setInterval> | null = null;
let waveformTimer: ReturnType<typeof setInterval> | null = null;
let recorderMimeType = "";
let rmsThreshold = DEFAULT_RMS_THRESHOLD;

// Current segment bookkeeping (reset whenever a new recorder starts).
let segmentStartedAt = 0;
let segmentSpeechTicks = 0;
let segmentPeakRms = 0;
let silenceTicks = 0;

let pendingChunks: PendingChunk[] = [];
let drainPromise: Promise<void> | null = null;
let rotationPromise: Promise<void> | null = null;
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

function getCurrentRms(): number {
  if (!analyserNode || !analysisBuffer) return 0;
  analyserNode.getByteTimeDomainData(analysisBuffer);
  return computeRms(analysisBuffer);
}

function sampleAndSendWaveform() {
  if (!analyserNode || !analysisBuffer || !captureActive) return;

  const buffer = analysisBuffer;
  analyserNode.getByteTimeDomainData(buffer);

  const bucketSize = Math.floor(buffer.length / WAVEFORM_BUCKETS);
  const buckets: number[] = [];
  for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
    let sum = 0;
    for (let j = 0; j < bucketSize; j++) {
      sum += Math.abs((buffer[i * bucketSize + j] - 128) / 128);
    }
    buckets.push(Math.min(1, (sum / bucketSize) * WAVEFORM_GAIN));
  }

  chrome.runtime.sendMessage({ type: "WAVEFORM_DATA", buckets }).catch(() => {});
}

function resetSegmentCounters(startedAt = Date.now()) {
  segmentStartedAt = startedAt;
  segmentSpeechTicks = 0;
  segmentPeakRms = 0;
  silenceTicks = 0;
}

function segmentHasSpeech(): boolean {
  return segmentSpeechTicks > 0 || segmentPeakRms >= rmsThreshold * NEAR_SPEECH_FACTOR;
}

/** Creates a recorder for the shared recorder stream (one per segment). */
function createRecorder(): MediaRecorder {
  if (!recorderStream) {
    throw new Error("Cannot create recorder without an active stream");
  }
  const recorder = recorderMimeType
    ? new MediaRecorder(recorderStream, { mimeType: recorderMimeType })
    : new MediaRecorder(recorderStream);
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
 * Ends the current segment and immediately starts the next one. The new
 * recorder starts before the old one stops, so consecutive segments overlap
 * by a few milliseconds instead of leaving a gap.
 */
function rotateSegment(mode: SegmentMode, reason: string): Promise<void> {
  if (rotationPromise) return rotationPromise;
  rotationPromise = (async () => {
    const previous = mediaRecorder;
    const startedAt = segmentStartedAt;
    const endedAt = Date.now();
    if (!previous || !recorderStream) return;

    try {
      mediaRecorder = createRecorder();
      mediaRecorder.start();
      resetSegmentCounters(endedAt);
    } catch (err) {
      relay(`recorder restart failed — ${(err as Error)?.message ?? "unknown error"}`);
      mediaRecorder = null;
      void failCapture("O gravador de áudio parou de responder.");
      return;
    }

    const blob = await stopRecorderAndCollect(previous);
    if (mode === "discard") {
      segmentsDiscarded += 1;
      return;
    }
    if (!blob || !isChunkViable(blob)) {
      relay(`segment skipped (${reason}) — ${blob?.size ?? 0} bytes`);
      return;
    }
    relay(
      `segment ready (${reason}) — ${blob.size} bytes, ${Math.round((endedAt - startedAt) / 1000)}s`,
    );
    enqueueChunk({ blob, startedAt, endedAt, attempts: 0 });
  })().finally(() => {
    rotationPromise = null;
  });
  return rotationPromise;
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
  if (!captureActive || rotationPromise || !mediaRecorder) return;

  const rms = getCurrentRms();
  if (rms > segmentPeakRms) segmentPeakRms = rms;
  if (rms >= rmsThreshold) {
    segmentSpeechTicks += 1;
    silenceTicks = 0;
  } else {
    silenceTicks += 1;
  }

  const age = Date.now() - segmentStartedAt;

  if (segmentSpeechTicks > 0 && silenceTicks >= SILENCE_FLUSH_TICKS && age >= MIN_SEGMENT_MS) {
    void rotateSegment("send", "pausa na fala");
    return;
  }
  if (age >= MAX_BUFFER_MS) {
    void rotateSegment(segmentHasSpeech() ? "send" : "discard", "limite de duração");
    return;
  }
  if (segmentSpeechTicks === 0 && age >= SILENT_SEGMENT_DISCARD_MS && !segmentHasSpeech()) {
    // Pure silence: restart the segment so it doesn't pile onto the next one.
    void rotateSegment("discard", "silêncio");
  }
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function cleanupResources() {
  captureActive = false;
  if (vadTimer) clearInterval(vadTimer);
  if (waveformTimer) clearInterval(waveformTimer);
  vadTimer = null;
  waveformTimer = null;

  stopTracks(mediaStream);
  stopTracks(microphoneStream);
  stopTracks(recorderStream);
  mediaStream = null;
  microphoneStream = null;
  recorderStream = null;

  if (audioContext) {
    try {
      await audioContext.close();
    } catch (err) {
      console.warn("[ValorBrainMeet][offscreen] AudioContext close failed:", err);
    }
    audioContext = null;
  }

  mediaRecorder = null;
  analyserNode = null;
  analysisBuffer = null;
  resetSegmentCounters(0);
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
    microphoneError = e?.name || "Error";
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

async function startCapture(streamId: string, includeMicrophone = true, vadThreshold?: number) {
  if (captureActive && mediaRecorder?.state === "recording") {
    return { microphoneActive: Boolean(microphoneStream), alreadyActive: true };
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

  mediaStream = await getTabAudioStream(streamId);
  if (!mediaStream) throw new Error("Não foi possível capturar o áudio da aba.");

  mediaStream.getTracks().forEach((track) => {
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

  const audioGraph = createOffscreenAudioGraph(audioContext, mediaStream);
  analyserNode = audioGraph.analyser;
  // Sized once per capture and reused by every VAD/waveform read.
  analysisBuffer = new Uint8Array(new ArrayBuffer(analyserNode.fftSize));

  if (includeMicrophone) {
    microphoneStream = await getMicrophoneStream();
    if (microphoneStream) {
      connectMicrophoneToOffscreenAudioGraph(audioContext, microphoneStream, audioGraph);
      microphoneStream.getTracks().forEach((track) => {
        track.onended = () => {
          if (!captureActive) return;
          relay("microphone track ended (input device disconnected)");
          chrome.runtime.sendMessage({ type: "OFFSCREEN_MIC_LOST" }).catch(() => {});
        };
      });
    }
  }

  recorderStream = audioGraph.recorderDestination.stream;
  recorderMimeType = pickSupportedMimeType();
  mediaRecorder = createRecorder();
  mediaRecorder.start();
  resetSegmentCounters();
  captureActive = true;

  waveformTimer = setInterval(sampleAndSendWaveform, WAVEFORM_INTERVAL_MS);
  vadTimer = setInterval(vadTick, VAD_SAMPLE_MS);

  relay(
    `capture started — mic=${Boolean(microphoneStream)} mime=${recorderMimeType || "default"} rmsThreshold=${rmsThreshold}`,
  );
  return { microphoneActive: Boolean(microphoneStream), microphoneError };
}

/**
 * Stops capture: records the final segment (only if it holds speech), posts
 * every pending chunk to the service worker and releases the devices.
 * Concurrent callers share the same promise.
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
      if (rotationPromise) await rotationPromise;
      const recorder = mediaRecorder;
      mediaRecorder = null;
      if (wasActive && recorder) {
        const startedAt = segmentStartedAt;
        const keep = segmentHasSpeech();
        const blob = await stopRecorderAndCollect(recorder);
        if (keep && blob && isChunkViable(blob)) {
          enqueueChunk({ blob, startedAt, endedAt: Date.now(), attempts: 0 });
        }
      }
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
    message.type === "OFFSCREEN_STOP_CAPTURE"
    ? true
    : false;
});
