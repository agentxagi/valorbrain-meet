import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TRANSCRIPT_SPEAKER,
  dominantSpeaker,
  isEchoOf,
  normalizeActiveSpeakerName,
  rangesOverlap,
  resolveTabSpeaker,
  resolveTranscriptSpeaker,
} from "./speakerAttribution.ts";

test("active speaker names are normalized with participant-name filtering", () => {
  assert.equal(normalizeActiveSpeakerName("Ada Lovelace"), "Ada Lovelace");
  assert.equal(normalizeActiveSpeakerName("Ada Lovelace Mute More options"), "Ada Lovelace");
});

test("invalid active speaker payloads are rejected", () => {
  assert.equal(normalizeActiveSpeakerName(undefined), null);
  assert.equal(normalizeActiveSpeakerName(""), null);
  assert.equal(normalizeActiveSpeakerName("Mute"), null);
  assert.equal(normalizeActiveSpeakerName("Ada…"), null);
});

test("transcript speaker falls back to the default audio label", () => {
  assert.equal(resolveTranscriptSpeaker("Grace Hopper"), "Grace Hopper");
  assert.equal(resolveTranscriptSpeaker(null), DEFAULT_TRANSCRIPT_SPEAKER);
  assert.equal(resolveTranscriptSpeaker("Pin"), DEFAULT_TRANSCRIPT_SPEAKER);
});

test("the dominant speaker is whoever talked longest inside the segment", () => {
  const events = [
    { name: "Ana", at: 0 },
    { name: "Bruno", at: 4000 },
    { name: "Ana", at: 16000 },
  ];
  // Segment 2 s–20 s: Ana 2 s + 4 s, Bruno 12 s.
  assert.equal(dominantSpeaker(events, 2000, 20000), "Bruno");
  // Ana was already speaking before the segment started.
  assert.equal(dominantSpeaker(events, 500, 3500), "Ana");
  assert.equal(dominantSpeaker([], 0, 1000), null);
  assert.equal(dominantSpeaker(events, 5000, 5000), null);
});

test("the recording user never wins a tab segment", () => {
  const events = [
    { name: "Gustavo", at: 0 },
    { name: "Ricardo", at: 9000 },
  ];
  assert.equal(
    dominantSpeaker(events, 0, 10000, (name) => name === "Gustavo"),
    "Ricardo",
  );
});

test("tab lines: dominant speaker, else the only other person, else Participante", () => {
  const base = { startedAt: 0, endedAt: 10000, currentSpeaker: null, selfNames: ["Gustavo"] };
  assert.equal(
    resolveTabSpeaker({
      ...base,
      events: [{ name: "Ana Souza", at: 0 }],
      participants: ["Gustavo", "Ana Souza", "Bruno"],
    }),
    "Ana Souza",
  );
  assert.equal(
    resolveTabSpeaker({ ...base, events: [], participants: ["Gustavo", "Ricardo"] }),
    "Ricardo",
    "one-to-one call: the tab is the other person",
  );
  assert.equal(
    resolveTabSpeaker({ ...base, events: [], participants: ["You", "Ricardo"], selfNames: [] }),
    "Ricardo",
  );
  assert.equal(
    resolveTabSpeaker({
      ...base,
      events: [],
      participants: ["Gus Teste", "Ricardo"],
      selfNames: ["Gustavo", "Gus Teste"],
    }),
    "Ricardo",
    "the Meet self name and the configured name both count as the user",
  );
  assert.equal(
    resolveTabSpeaker({ ...base, events: [], participants: ["Gustavo", "Ana", "Bruno"] }),
    DEFAULT_TRANSCRIPT_SPEAKER,
  );
  assert.equal(
    resolveTabSpeaker({ ...base, events: [], participants: [], currentSpeaker: "Gustavo" }),
    DEFAULT_TRANSCRIPT_SPEAKER,
    "the self tile lighting up is not someone else speaking",
  );
});

test("meeting audio leaking into the microphone is recognised as an echo", () => {
  const tab = "Eu reviso a página de preços amanhã de manhã, e o changelog sai na quinta.";
  assert.equal(isEchoOf("reviso a página de preços amanhã de manhã", tab), true);
  assert.equal(isEchoOf("Concordo. Eu aviso o time comercial hoje à tarde.", tab), false);
  assert.equal(isEchoOf("Sim, sim.", tab), false, "too short to judge");
});

test("time ranges overlap with drift between channels", () => {
  const a = { startedAt: 10_000, endedAt: 20_000 };
  assert.equal(rangesOverlap(a, { startedAt: 21_000, endedAt: 25_000 }), true);
  assert.equal(rangesOverlap(a, { startedAt: 24_000, endedAt: 25_000 }), false);
  assert.equal(rangesOverlap(a, { startedAt: 2_000, endedAt: 8_000 }), true);
});
