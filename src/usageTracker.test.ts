import assert from "node:assert/strict";
import test from "node:test";

import { calculateDeltaCost } from "./usageTracker";

/** Cost of a million input and a million output tokens (thinking is output). */
function millionEach(model: string): number {
  return calculateDeltaCost({ promptTokens: 1_000_000, completionTokens: 1_000_000, model }).cost;
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
}

test("Claude models have an estimated cost, by model", () => {
  near(millionEach("claude-opus-5-5"), 4 + 20);
  near(millionEach("claude-sonnet-5-5"), 2 + 10);
  near(millionEach("claude-haiku-5-5"), 0.1 + 0.5);
  // An id with a suffix is the same model.
  near(millionEach("claude-opus-5-5-20261001"), 24);
});

test("other models keep their price, or none", () => {
  near(millionEach("gpt-4o-mini"), 0.15 + 0.6);
  assert.equal(millionEach("glm-5.3-flash"), 0);
  assert.equal(calculateDeltaCost({ promptTokens: 1000, completionTokens: 1000 }).cost, 0);
});
