import test from "node:test";
import assert from "node:assert/strict";

import {
  actionRule,
  appendDistinct,
  decisionRule,
  isNearDuplicate,
  isPlaceholderName,
  normalizeItemText,
  textRule,
  topicRule,
} from "./nearDuplicates.ts";
import type { ActionItem, Decision, Topic } from "./types.ts";

test("normalizeItemText drops case, accents, punctuation and full-width forms", () => {
  assert.equal(normalizeItemText("  Perfilar o GUSTAVO — já!  "), "perfilar o gustavo ja");
  assert.equal(normalizeItemText("Preço: R$ 22.990"), "preco r 22 990");
  assert.equal(normalizeItemText("ＡＢＣ１２３"), "abc123");
  assert.equal(normalizeItemText("İstanbul"), "istanbul");
  // Hangul syllables come back whole (decomposed, then composed again).
  assert.equal(normalizeItemText("보내지 않는다."), "보내지 않는다");
  assert.equal(normalizeItemText(undefined), "");
});

test("rewordings from a real meeting are the same item", () => {
  assert.ok(
    isNearDuplicate(
      "Perfilhar Gustavo da melhor forma para indicar o programa certo de mentoria",
      "Perfilar Gustavo da melhor forma para indicar o programa certo de mentoria",
    ),
  );
  assert.ok(
    isNearDuplicate(
      "Desenhar a carta de apresentação do Gustavo para os recrutadores.",
      "desenhar a carta de apresentacao do Gustavo para os recrutadores",
    ),
  );
  assert.ok(isNearDuplicate("Qual é o valor do serviço?", "qual é o valor do serviço"));
  // Same numbers, written alike: "05/10" and "5/10" are the same date.
  assert.ok(
    isNearDuplicate(
      "Parcelar o programa em 21x de 520 reais pelo cartão até 05/10",
      "Parcelar o programa em 21x de 520 reais via cartão até 5/10",
    ),
  );
});

test("short items are the same only when they read the same", () => {
  assert.equal(isNearDuplicate("Definir o preço", "Definir preço"), false);
  assert.equal(isNearDuplicate("Definir o preço!", "definir o PREÇO"), true);
  assert.equal(isNearDuplicate("", ""), false);
  assert.equal(isNearDuplicate("?!", "..."), false);
});

test("a negation among the words that differ keeps two items apart", () => {
  const pairs: Array<[string, string]> = [
    [
      "Gustavo decide aderir ao programa de mentoria agora",
      "Gustavo decide não aderir ao programa de mentoria agora",
    ],
    [
      "We can send the revised proposal to Carlos by email",
      "We can't send the revised proposal to Carlos by email",
    ],
    [
      "Enviaremos la propuesta revisada al cliente esta semana",
      "No enviaremos la propuesta revisada al cliente esta semana",
    ],
    [
      "Le client a validé la proposition commerciale cette semaine",
      "Le client n'a pas validé la proposition commerciale cette semaine",
    ],
    [
      "Wir schicken das neue Angebot heute an den Kunden",
      "Wir schicken das neue Angebot heute nicht an den Kunden",
    ],
    [
      "Il cliente vuole firmare il contratto questa settimana",
      "Il cliente non vuole firmare il contratto questa settimana",
    ],
    [
      "Pagar o programa em parcelas com juros no cartão",
      "Pagar o programa em parcelas sem juros no cartão",
    ],
    // Words from Intl.Segmenter in scripts written without spaces.
    ["我们同意这个价格方案", "我们不同意这个价格方案"],
    ["我们今天在会议上决定价格", "我们今天在会议上没有决定价格"],
    [
      "来週の月曜日に東京のお客様へ新しい見積書をメールで送付する予定です",
      "来週の月曜日に東京のお客様へ新しい見積書をメールで送付しない予定です",
    ],
    ["ส่งข้อเสนอให้ลูกค้าภายในสัปดาห์หน้า", "ไม่ส่งข้อเสนอให้ลูกค้าภายในสัปดาห์หน้า"],
    ["다음 주에 고객에게 새 제안서를 보낸다", "다음 주에 고객에게 새 제안서를 안 보낸다"],
  ];
  // Each pair shares at least 80% of its words: only the negation keeps it apart.
  for (const [a, b] of pairs) assert.equal(isNearDuplicate(a, b), false, `${a} / ${b}`);
});

test("different numbers, number words or dates keep two items apart", () => {
  const pairs: Array<[string, string]> = [
    [
      "Parcelar o programa em 21x de 500 reais pelo cartão",
      "Parcelar o programa em 21x de 520 reais pelo cartão",
    ],
    [
      "Fechar o pacote completo de mentoria por 22.990 reais à vista",
      "Fechar o pacote completo de mentoria por 12.990 reais à vista",
    ],
    [
      "Pagar o programa completo em cinco parcelas pelo cartão",
      "Pagar o programa completo em seis parcelas pelo cartão",
    ],
    [
      "Enviar a proposta revisada para o Carlos até sexta-feira à tarde",
      "Enviar a proposta revisada para o Carlos até segunda-feira à tarde",
    ],
    ["我们计划在三个月内完成新版本的开发和发布", "我们计划在六个月内完成新版本的开发和发布"],
  ];
  // Each pair shares at least 80% of its words: only the numbers keep it apart.
  for (const [a, b] of pairs) assert.equal(isNearDuplicate(a, b), false, `${a} / ${b}`);
});

test("near-duplicates are found in scripts written without spaces", () => {
  assert.ok(isNearDuplicate("我们决定下周发布新版本给所有客户", "我们决定下周发布新版本给客户"));
  assert.ok(
    isNearDuplicate("来週、新しいバージョンを公開します。", "来週新しいバージョンを公開します"),
  );
});

test("appendDistinct keeps the earliest item and completes it from its repeats", () => {
  const decisions: Decision[] = [
    {
      text: "Lançar a versão 2 na sexta-feira",
      chunkId: "chunk_3",
      timestampLabel: "00:30",
      classification: "tentative",
    },
  ];
  const merged = appendDistinct(
    decisions,
    [
      {
        text: "lançar a versão 2 na sexta-feira!",
        by: "Ana",
        chunkId: "chunk_9",
        classification: "finalized",
      },
      { text: "Lançar a versão 2 na sexta-feira", by: "Bruno" },
      { text: "Contratar mais um desenvolvedor", by: "Bruno" },
    ],
    decisionRule,
  );
  assert.deepEqual(merged, [
    {
      text: "Lançar a versão 2 na sexta-feira",
      chunkId: "chunk_3",
      timestampLabel: "00:30",
      classification: "tentative",
      by: "Ana",
    },
    { text: "Contratar mais um desenvolvedor", by: "Bruno" },
  ]);
  assert.equal(decisions[0].by, undefined, "the inputs are not changed");
});

test("appendDistinct keeps the same task apart for two people or two dates", () => {
  const task = "Revisar o contrato de prestação de serviços";
  const byPerson = appendDistinct<ActionItem>(
    [{ task, owner: "Ana" }],
    [
      { task, owner: "Bruno" },
      { task, owner: "Ana Souza", deadline: "sexta" },
      { task, owner: "Participante" },
    ],
    actionRule,
  );
  assert.deepEqual(byPerson, [
    { task, owner: "Ana", deadline: "sexta" },
    { task, owner: "Bruno" },
  ]);

  const byDate = appendDistinct<ActionItem>(
    [{ task, deadline: "até sexta-feira" }],
    [
      { task, deadline: "segunda" },
      { task, deadline: "sexta", owner: "Ana" },
    ],
    actionRule,
  );
  assert.deepEqual(byDate, [
    { task, deadline: "até sexta-feira", owner: "Ana" },
    { task, deadline: "segunda" },
  ]);
});

test("appendDistinct turns an idea into a commitment and keeps the higher confidence", () => {
  const merged = appendDistinct<ActionItem>(
    [{ task: "Mandar o link da gravação", confidence: "low", isSpeculative: true }],
    [{ task: "mandar o link da gravação", confidence: "high", isSpeculative: false }],
    actionRule,
  );
  assert.deepEqual(merged, [
    { task: "Mandar o link da gravação", confidence: "high", isSpeculative: false },
  ]);
  const stillIdea = appendDistinct<ActionItem>(
    [{ task: "Gravar um vídeo de apresentação", confidence: "medium", isSpeculative: true }],
    [{ task: "Gravar um vídeo de apresentação", confidence: "low", isSpeculative: true }],
    actionRule,
  );
  assert.deepEqual(stillIdea, [
    { task: "Gravar um vídeo de apresentação", confidence: "medium", isSpeculative: true },
  ]);
});

test("appendDistinct gives a topic said again its latest status", () => {
  const topics = appendDistinct<Topic>(
    [{ name: "Preço do programa", status: "active" }],
    [
      { name: "preço do programa", status: "completed" },
      { name: "Agenda da mentoria", status: "active" },
    ],
    topicRule,
  );
  assert.deepEqual(topics, [
    { name: "Preço do programa", status: "completed" },
    { name: "Agenda da mentoria", status: "active" },
  ]);
});

test("appendDistinct merges plain texts, also within the incoming list, and caps the list", () => {
  assert.deepEqual(
    appendDistinct(
      ["Qual o preço?"],
      ["qual o preço", "Quando começa?", "quando começa"],
      textRule,
    ),
    ["Qual o preço?", "Quando começa?"],
  );
  assert.deepEqual(appendDistinct(["a", "b"], ["c"], textRule, 2), ["b", "c"]);
  const existing = ["x"];
  assert.equal(appendDistinct(existing, [], textRule), existing);
});

test("isPlaceholderName recognises the labels used for unknown speakers", () => {
  for (const name of ["Participante", "You", "Você", "voce", "Audio"]) {
    assert.equal(isPlaceholderName(name), true, name);
  }
  assert.equal(isPlaceholderName("Gustavo"), false);
  assert.equal(isPlaceholderName(""), false);
});
