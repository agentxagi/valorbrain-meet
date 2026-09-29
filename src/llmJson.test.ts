import test from "node:test";
import assert from "node:assert/strict";

import { extractJsonObject } from "./llmJson.ts";

test("parses a plain JSON object", () => {
  assert.deepEqual(extractJsonObject('{"summary":"ok","decisions":[]}'), {
    summary: "ok",
    decisions: [],
  });
});

test("strips reasoning blocks and Markdown fences", () => {
  const raw = '<think>vou pensar</think>\n```json\n{"summary":"resumo"}\n```';
  assert.deepEqual(extractJsonObject(raw), { summary: "resumo" });
});

test("recovers the object from surrounding prose, even with braces inside strings", () => {
  const raw = 'Claro! Segue: {"summary":"usar {chaves} no texto","n":1} Espero ter ajudado.';
  assert.deepEqual(extractJsonObject(raw), { summary: "usar {chaves} no texto", n: 1 });
});

test("returns null for arrays, invalid JSON and non-strings", () => {
  assert.equal(extractJsonObject("[1,2,3]"), null);
  assert.equal(extractJsonObject("{summary: sem aspas}"), null);
  assert.equal(extractJsonObject(undefined), null);
  assert.equal(extractJsonObject(42), null);
});

test("passes plain objects through untouched", () => {
  const value = { summary: "já objeto" };
  assert.equal(extractJsonObject(value), value);
});
