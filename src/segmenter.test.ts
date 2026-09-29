import test from "node:test";
import assert from "node:assert/strict";

import { requiredPauseMs, SpeechSegmenter, type SegmentDecision } from "./segmenter.ts";

const CONFIG = {
  tickMs: 250,
  minSegmentMs: 2500,
  maxSegmentMs: 28000,
  silentDiscardMs: 10000,
  baseThreshold: 0.012,
};

/** Feeds a sequence of RMS values (one per 250 ms tick) and returns the first cut. */
function run(values: number[], segmenter = new SpeechSegmenter(CONFIG)) {
  segmenter.reset(0);
  for (let i = 0; i < values.length; i += 1) {
    const decision: SegmentDecision = segmenter.tick(values[i], (i + 1) * 250);
    if (decision.action !== "continue") return { ...decision, atMs: (i + 1) * 250 };
  }
  return { action: "continue" as const, atMs: values.length * 250 };
}

const speech = (seconds: number, level = 0.08) =>
  Array.from({ length: seconds * 4 }, (_, i) => level * (0.6 + 0.4 * Math.abs(Math.sin(i))));
const quiet = (seconds: number, level = 0.002) => Array.from({ length: seconds * 4 }, () => level);

test("the pause needed to cut shrinks as the segment grows", () => {
  assert.equal(requiredPauseMs(3000), 1250);
  assert.equal(requiredPauseMs(12000), 750);
  assert.equal(requiredPauseMs(18000), 500);
  assert.equal(requiredPauseMs(25000), 250);
});

test("a short sentence followed by a clear pause is cut at the pause", () => {
  const cut = run([...speech(4), ...quiet(3)]);
  assert.equal(cut.action, "send");
  assert.equal(cut.reason, "pausa na fala");
  assert.equal(cut.atMs, 4000 + 1250);
});

test("a brief breath early in a segment does not cut it", () => {
  const cut = run([...speech(4), ...quiet(0.5), ...speech(4)]);
  assert.equal(cut.action, "continue");
});

test("a long monologue is cut at a short breath instead of the hard limit", () => {
  // 17 s of speech, a half-second breath, more speech.
  const cut = run([...speech(17), ...quiet(0.5), ...speech(10)]);
  assert.equal(cut.action, "send");
  assert.equal(cut.reason, "pausa na fala");
  assert.ok(cut.atMs > 17000 && cut.atMs <= 17500, `cut at ${cut.atMs}`);
});

test("continuous speech is cut at the hard limit", () => {
  const cut = run(speech(40));
  assert.equal(cut.action, "send");
  assert.equal(cut.reason, "limite de duração");
  assert.equal(cut.atMs, 28000);
});

test("pauses are found above a constant background noise", () => {
  // Room noise at 0.03 (above the base threshold) never counts as a pause for
  // a fixed threshold; the adaptive threshold sees the drop from speech.
  const segmenter = new SpeechSegmenter(CONFIG);
  segmenter.reset(0);
  // Warm the noise history with background noise only.
  for (let i = 0; i < 40; i += 1) segmenter.tick(0.03, (i + 1) * 250);
  segmenter.reset(10_000);
  const values = [...speech(6, 0.25), ...quiet(2, 0.03)];
  let cut: SegmentDecision = { action: "continue" };
  let at = 0;
  for (let i = 0; i < values.length && cut.action === "continue"; i += 1) {
    at = 10_000 + (i + 1) * 250;
    cut = segmenter.tick(values[i], at);
  }
  assert.equal(cut.action, "send");
  assert.equal(at - 10_000, 6000 + 1250);
});

test("a quiet voice in a noisy room is still sent, never discarded", () => {
  // Speech barely above the noise: the base threshold (not the adaptive one)
  // decides whether the segment holds speech.
  const cut = run(speech(40, 0.02).map((v) => Math.max(v, 0.013)));
  assert.equal(cut.action, "send");
});

test("pure silence is discarded after the silence limit", () => {
  const cut = run(quiet(15));
  assert.equal(cut.action, "discard");
  assert.equal(cut.reason, "silêncio");
  assert.equal(cut.atMs, 10000);
});

test("near-speech noise at the hard limit keeps the segment", () => {
  const segmenter = new SpeechSegmenter(CONFIG);
  const cut = run(
    Array.from({ length: 28 * 4 }, () => 0.009),
    segmenter,
  );
  // 0.009 >= 0.6 × 0.012: may be speech, so it is sent rather than lost.
  assert.equal(cut.action, "send");
  assert.equal(cut.reason, "limite de duração");
});
