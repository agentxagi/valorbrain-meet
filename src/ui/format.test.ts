import test from "node:test";
import assert from "node:assert/strict";

import {
  formatClock,
  formatDurationHuman,
  formatRelative,
  hostOf,
  initials,
  maskSecret,
  plural,
  sentimentLabel,
  speakerLabel,
  topicStatusLabel,
} from "./format.ts";

test("clock and human durations", () => {
  assert.equal(formatClock(75), "01:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(-5), "00:00");
  assert.equal(formatDurationHuman(45), "45 s");
  assert.equal(formatDurationHuman(720), "12 min");
  assert.equal(formatDurationHuman(3900), "1 h 05 min");
  assert.equal(formatDurationHuman(7200), "2 h");
});

test("relative time in PT-BR", () => {
  const now = 1_000_000_000;
  assert.equal(formatRelative(now - 10_000, now), "agora");
  assert.equal(formatRelative(now - 5 * 60_000, now), "há 5 min");
  assert.equal(formatRelative(now - 3 * 3_600_000, now), "há 3 h");
  assert.equal(formatRelative(0, now), "");
});

test("labels are PT-BR and map internal placeholders", () => {
  assert.equal(sentimentLabel("positive"), "Positivo");
  assert.equal(sentimentLabel("whatever"), "Neutro");
  assert.equal(topicStatusLabel("unresolved"), "Sem conclusão");
  assert.equal(speakerLabel("Audio"), "Participante");
  assert.equal(speakerLabel("You"), "Você");
  assert.equal(speakerLabel("Ana Souza"), "Ana Souza");
  assert.equal(initials("Ana Souza"), "AS");
  assert.equal(initials("Audio"), "PA");
  assert.equal(plural(1, "fala", "falas"), "1 fala");
  assert.equal(plural(3, "fala", "falas"), "3 falas");
});

test("secrets are masked and hosts extracted", () => {
  assert.equal(maskSecret("vbm_1234567890abcdef"), "vbm_12…cdef");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret(""), "");
  assert.equal(hostOf("https://valorbrain-api.valor.digital/x"), "valorbrain-api.valor.digital");
});
