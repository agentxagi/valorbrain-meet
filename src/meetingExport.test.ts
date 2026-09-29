import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMeetingJson,
  buildMeetingMarkdown,
  buildMeetingText,
  exportFilename,
  meetingTitle,
} from "./meetingExport.ts";
import type { State } from "./types.ts";

function session(overrides: Partial<State> = {}): State {
  return {
    isActive: false,
    meetingId: "abc-defg-hij",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    startTime: new Date(2026, 8, 29, 14, 5).getTime(),
    savedAt: new Date(2026, 8, 29, 14, 50).getTime(),
    duration: 2700,
    summary: "Lançamento definido para sexta.",
    topics: [{ name: "Lançamento da versão 2", status: "completed" }],
    decisions: [{ text: "Lançar na sexta", by: "Ana", classification: "tentative" }],
    actionItems: [{ task: "Preparar o changelog", owner: "Bruno", deadline: "quinta" }],
    currentTopic: "",
    sentiment: "positive",
    keyInsights: [{ text: "Prazo apertado", confidenceScore: 80 }],
    unresolvedDiscussions: ["Preço do plano empresarial"],
    contradictions: [],
    questionsRaised: [],
    participants: ["You", "Ana", "Bruno"],
    initialParticipants: [],
    lateJoiners: [],
    timeline: [],
    transcript: [
      { speaker: "Audio", text: "Bom dia.", timestamp: 0, timestampLabel: "00:00" },
      { speaker: "Ana", text: "Vamos lançar na sexta.", timestamp: 75 },
    ],
    summaryItems: [],
    audioActive: false,
    ...overrides,
  };
}

test("meetingTitle prefers the first topic, then the Meet code", () => {
  assert.equal(meetingTitle(session()), "Lançamento da versão 2");
  assert.equal(meetingTitle(session({ topics: [] })), "abc-defg-hij");
  assert.equal(
    meetingTitle(session({ topics: [], meetingId: "unknown" })),
    "Reunião no Google Meet",
  );
});

test("exportFilename is dated and accent-free", () => {
  assert.equal(exportFilename(session(), "md"), "reuniao-2026-09-29-lancamento-da-versao-2.md");
});

test("markdown export is in PT-BR with ticked actions and fixed timestamps", () => {
  const md = buildMeetingMarkdown(session(), {
    isActionDone: (task) => task === "Preparar o changelog",
  });
  assert.match(md, /^# Lançamento da versão 2\n/);
  assert.match(md, /- \*\*Duração:\*\* 45 min/);
  assert.match(md, /- \*\*Participantes:\*\* Ana, Bruno/);
  assert.match(md, /## Decisões\n- Lançar na sexta _\(Ana, a confirmar\)_/);
  assert.match(md, /## Próximos passos\n- \[x\] Preparar o changelog — Bruno \(prazo: quinta\)/);
  assert.match(md, /## Pontos em aberto\n- Preço do plano empresarial/);
  assert.match(md, /\*\*\[00:00\] Participante:\*\* Bom dia\./);
  assert.match(md, /\*\*\[01:15\] Ana:\*\* Vamos lançar na sexta\./);
  assert.doesNotMatch(md, /Meeting|Summary|Action Items/);
});

test("text and JSON exports carry the same content", () => {
  const txt = buildMeetingText(session());
  assert.match(txt, /^LANÇAMENTO DA VERSÃO 2/);
  assert.match(txt, /PRÓXIMOS PASSOS\n {2}\[ \] Preparar o changelog — Bruno \(prazo: quinta\)/);
  assert.match(txt, /\[01:15\] Ana: Vamos lançar na sexta\./);

  const data = JSON.parse(buildMeetingJson(session()));
  assert.equal(data.title, "Lançamento da versão 2");
  assert.equal(data.durationSeconds, 2700);
  assert.deepEqual(data.participants, ["Ana", "Bruno"]);
  assert.equal(data.transcript.length, 2);
});
