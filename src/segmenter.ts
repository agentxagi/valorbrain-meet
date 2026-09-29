/**
 * @fileoverview Decides where to cut the recording into segments for
 * transcription, one tick (VAD_SAMPLE_MS) at a time.
 *
 * Whisper transcribes a segment best when it starts and ends at a pause: a
 * word cut in half at a segment boundary is lost or garbled on both sides.
 * Real meetings rarely have 1.5 s of silence, so the required pause shrinks as
 * the segment grows (a long monologue is cut at the next short breath), and
 * the pause threshold adapts to the background noise of each stream.
 *
 * Two thresholds on purpose:
 * - the configured `baseThreshold` decides whether a segment contains speech
 *   at all (never raised: a quiet voice in a noisy room must not be dropped);
 * - the adaptive pause threshold only decides where to cut.
 *
 * Pure module: no Web Audio, unit-tested in node.
 */

export interface SegmenterConfig {
  /** Duration of one tick in ms. */
  tickMs: number;
  /** Segments are not closed on a pause before this age. */
  minSegmentMs: number;
  /** Hard cut: a segment never grows beyond this. */
  maxSegmentMs: number;
  /** A segment without any speech is restarted (discarded) after this long. */
  silentDiscardMs: number;
  /** RMS at or above which a tick counts as speech. */
  baseThreshold: number;
}

export type SegmentDecision =
  | { action: "continue" }
  | { action: "send" | "discard"; reason: string };

/** Ticks of history used to estimate the noise floor (~20 s at 250 ms). */
const NOISE_HISTORY_TICKS = 80;
/** A tick is a pause when it is below this multiple of the noise floor… */
const NOISE_FLOOR_FACTOR = 2.5;
/** …and below this fraction of the loud (speech) level, so speech is never a pause. */
const SPEECH_LEVEL_FACTOR = 0.35;
/** Loudest tick below this fraction of the threshold means the segment is silence. */
const NEAR_SPEECH_FACTOR = 0.6;

/** Pause (ms) needed to close a segment of the given age. */
export function requiredPauseMs(ageMs: number): number {
  if (ageMs < 10_000) return 1250;
  if (ageMs < 16_000) return 750;
  if (ageMs < 22_000) return 500;
  return 250;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index];
}

export class SpeechSegmenter {
  private readonly history: number[] = [];
  private startedAt = 0;
  private speechTicks = 0;
  private peakRms = 0;
  private pauseMs = 0;

  constructor(private readonly config: SegmenterConfig) {}

  /** Starts a new segment (after a rotation or when capture starts). */
  reset(startedAt: number): void {
    this.startedAt = startedAt;
    this.speechTicks = 0;
    this.peakRms = 0;
    this.pauseMs = 0;
  }

  get segmentStartedAt(): number {
    return this.startedAt;
  }

  /** Whether the current segment holds anything that may be speech. */
  hasSpeech(): boolean {
    return this.speechTicks > 0 || this.peakRms >= this.config.baseThreshold * NEAR_SPEECH_FACTOR;
  }

  /**
   * RMS below which a tick counts as a pause: above the noise floor of a noisy
   * room, but always well under the level of the speech itself (the history
   * may hold no silence at all during a monologue).
   */
  pauseThreshold(): number {
    const floor = percentile(this.history, 0.1) * NOISE_FLOOR_FACTOR;
    const speechCeiling = percentile(this.history, 0.9) * SPEECH_LEVEL_FACTOR;
    return Math.max(this.config.baseThreshold, Math.min(floor, speechCeiling));
  }

  /** Feeds one RMS reading taken at `now` and says what to do with the segment. */
  tick(rms: number, now: number): SegmentDecision {
    const value = Number.isFinite(rms) && rms > 0 ? rms : 0;
    this.history.push(value);
    if (this.history.length > NOISE_HISTORY_TICKS) this.history.shift();

    if (value > this.peakRms) this.peakRms = value;
    if (value >= this.config.baseThreshold) this.speechTicks += 1;
    if (value < this.pauseThreshold()) this.pauseMs += this.config.tickMs;
    else this.pauseMs = 0;

    const age = now - this.startedAt;
    if (
      this.speechTicks > 0 &&
      age >= this.config.minSegmentMs &&
      this.pauseMs >= requiredPauseMs(age)
    ) {
      return { action: "send", reason: "pausa na fala" };
    }
    if (age >= this.config.maxSegmentMs) {
      return { action: this.hasSpeech() ? "send" : "discard", reason: "limite de duração" };
    }
    if (this.speechTicks === 0 && age >= this.config.silentDiscardMs && !this.hasSpeech()) {
      return { action: "discard", reason: "silêncio" };
    }
    return { action: "continue" };
  }
}
