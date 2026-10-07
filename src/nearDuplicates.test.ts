import test from "node:test";
import assert from "node:assert/strict";

import {
  actionRule,
  appendDistinct,
  decisionRule,
  isNearDuplicate,
  isPlaceholderName,
  normalizeItemText,
  sharesContent,
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

test("the same item said again is found despite case, accents, punctuation and articles", () => {
  assert.ok(
    isNearDuplicate(
      "Desenhar a carta de apresentação do Gustavo para os recrutadores.",
      "desenhar a carta de apresentacao do Gustavo para os recrutadores",
    ),
  );
  assert.ok(isNearDuplicate("Qual é o valor do serviço?", "qual é o valor do serviço"));
  assert.ok(
    isNearDuplicate("Explicar o follow-up ao Carlos Levy", "Explicar o follow up ao Carlos Levy."),
  );
  // Articles apart, the same words in the same order ("05/10" and "5/10" are one date).
  assert.ok(
    isNearDuplicate(
      "Enviar a proposta revisada para o Carlos até 05/10",
      "Enviar proposta revisada para Carlos até 5/10",
    ),
  );
});

test("one word changed, moved or spelled differently keeps two items apart", () => {
  const pairs: Array<[string, string]> = [
    // Each of these shares at least 80% of its words.
    [
      "Gustavo aceita a proposta de 21x de 520 reais no cartão de crédito",
      "Gustavo recusa a proposta de 21x de 520 reais no cartão de crédito",
    ],
    [
      "Aprovar o orçamento de marketing digital para o próximo trimestre da empresa",
      "Rejeitar o orçamento de marketing digital para o próximo trimestre da empresa",
    ],
    [
      "Gustavo fecha o plano anual de mentoria com pagamento pelo cartão de crédito",
      "Gustavo fecha o plano mensal de mentoria com pagamento pelo cartão de crédito",
    ],
    [
      "Gustavo não aceita o plano anual mas aceita o plano mensal",
      "Gustavo aceita o plano anual mas não aceita o plano mensal",
    ],
    [
      "Leonardo envia o contrato assinado para o Gustavo amanhã cedo",
      "Gustavo envia o contrato assinado para o Leonardo amanhã cedo",
    ],
    [
      "Enviar o desconto combinado para o Gustavo por e-mail ainda hoje",
      "Enviar o desconto combinado para o Carlos por e-mail ainda hoje",
    ],
    [
      "Fazer a primeira reunião de alinhamento com o time comercial da empresa",
      "Fazer a segunda reunião de alinhamento com o time comercial da empresa",
    ],
    [
      "Revisar o contrato de prestação de serviços antes da assinatura do cliente",
      "Revisar o contrato de prestação de serviços depois da assinatura do cliente",
    ],
    [
      "Incluir o módulo de oratória no pacote completo do programa de mentoria",
      "Excluir o módulo de oratória no pacote completo do programa de mentoria",
    ],
    [
      "Cobrar mais pelo módulo de oratória no pacote completo do programa",
      "Cobrar menos pelo módulo de oratória no pacote completo do programa",
    ],
    [
      "Concluir a matrícula do Gustavo no programa completo é possível este mês",
      "Concluir a matrícula do Gustavo no programa completo é impossível este mês",
    ],
    // A reworded word is left to the review at the end, where the model decides.
    [
      "Perfilhar Gustavo da melhor forma para indicar o programa certo de mentoria",
      "Perfilar Gustavo da melhor forma para indicar o programa certo de mentoria",
    ],
    [
      "Ligar para o Paulo amanhã cedo para confirmar a matrícula no programa",
      "Ligar para a Paula amanhã cedo para confirmar a matrícula no programa",
    ],
  ];
  for (const [a, b] of pairs) assert.equal(isNearDuplicate(a, b), false, `${a} / ${b}`);
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
  // Each pair shares at least 80% of its words.
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
  // Each pair shares at least 80% of its words.
  for (const [a, b] of pairs) assert.equal(isNearDuplicate(a, b), false, `${a} / ${b}`);
});

test("accents, signs and a number's separators keep two items apart", () => {
  const pairs: Array<[string, string]> = [
    ["Das Projekt wurde vom Vorstand genehmigt", "Das Projekt würde vom Vorstand genehmigt"],
    ["Wir zahlen die Rechnungen im Oktober", "Wir zählen die Rechnungen im Oktober"],
    ["Sí, firmamos el contrato anual", "Si firmamos el contrato anual"],
    ["O avô vai assinar o contrato hoje", "A avó vai assinar o contrato hoje"],
    ["Ele pode pagar a entrada amanhã", "Ele pôde pagar a entrada amanhã"],
    ["Pagamento de 500 € por mês", "Pagamento de 500 $ por mês"],
    ["Desconto de 10% no plano anual", "Desconto de 10 no plano anual"],
    ["Margem de -5% no trimestre", "Margem de 5% no trimestre"],
    ["Prazo de 1/2 mês para entrega", "Prazo de 1,2 mês para entrega"],
    ["Taxa de 1.05 ao mês no plano anual", "Taxa de 1.5 ao mês no plano anual"],
  ];
  for (const [a, b] of pairs) assert.equal(isNearDuplicate(a, b), false, `${a} / ${b}`);

  // The same sign written closer or farther from its number is still the same item.
  assert.ok(
    isNearDuplicate("Pagar R$500 de entrada no cartão", "Pagar R$ 500 de entrada no cartão"),
  );
  assert.ok(isNearDuplicate("Desconto de 10% no plano anual", "Desconto de 10 % no plano anual"));
  // "à" is "a" fused with an article: "à vista" and "a vista" say the same.
  assert.ok(
    isNearDuplicate(
      "Fechar o pacote de mentoria por 12.990 reais à vista",
      "Fechar o pacote de mentoria por 12.990 reais a vista",
    ),
  );
});

test("typed without accents, a word only an accent tells apart keeps two items apart", () => {
  const pairs: Array<[string, string]> = [
    ["Sí, el cliente firmará el contrato anual", "Si el cliente firmara el contrato anual"],
    ["O cliente pôde pagar a entrada à vista", "O cliente pode pagar a entrada a vista"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(isNearDuplicate(a, b), false, `${a} / ${b}`);
    assert.equal(isNearDuplicate(b, a), false, `${b} / ${a}`);
  }
  // Without such a word, a text typed without accents is still the same item.
  assert.ok(
    isNearDuplicate(
      "Enviar a apresentação do serviço até sexta",
      "Enviar a apresentacao do servico ate sexta",
    ),
  );
});

test("scripts written without spaces have words too", () => {
  // Punctuation changes where the words fall: the words themselves are the same.
  assert.ok(isNearDuplicate("我们决定，下周发布新版本。", "我们决定下周发布新版本"));
  assert.ok(
    isNearDuplicate("来週、新しいバージョンを公開します。", "来週新しいバージョンを公開します"),
  );
  assert.equal(
    isNearDuplicate("我们决定下周发布新版本给所有客户", "我们决定下周发布新版本给客户"),
    false,
    "a word more is another item",
  );
});

test("sharesContent looks for a number or a word of content in common", () => {
  assert.equal(sharesContent("Enviar o contrato à Ana", "Revisar o CONTRATO"), true);
  assert.equal(sharesContent("Qual é o preço do serviço?", "qual o preco"), true, "accents apart");
  assert.equal(sharesContent("Fechar em 12 parcelas", "Opção de 12x"), true, "a number");
  assert.equal(sharesContent("我们决定下周发布新版本", "下周开会"), true, "two characters suffice");
  assert.equal(sharesContent("Enviar o link da reunião", "Ligar para a Ana"), false);
  assert.equal(sharesContent("O de a", "a de o"), false, "articles and short words do not count");
  assert.equal(sharesContent("我们决定下周发布新版本", "价格方案"), false);
});

test("appendDistinct keeps the earliest item, completed and with its latest classification", () => {
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
      // The earliest text and source; confirmed later, so no longer "a confirmar".
      text: "Lançar a versão 2 na sexta-feira",
      chunkId: "chunk_3",
      timestampLabel: "00:30",
      classification: "finalized",
      by: "Ana",
    },
    { text: "Contratar mais um desenvolvedor", by: "Bruno" },
  ]);
  assert.equal(decisions[0].by, undefined, "the inputs are not changed");
  assert.equal(decisions[0].classification, "tentative");
});

test("a real name said later replaces a placeholder, never the other way round", () => {
  const actions = appendDistinct<ActionItem>(
    [{ task: "Mandar o contrato revisado", owner: "Participante" }],
    [
      { task: "Mandar o contrato revisado", owner: "Você" },
      { task: "mandar o contrato revisado", owner: "Leonardo" },
      { task: "Mandar o contrato revisado.", owner: "Participante" },
    ],
    actionRule,
  );
  assert.deepEqual(actions, [{ task: "Mandar o contrato revisado", owner: "Leonardo" }]);
  const decisions = appendDistinct<Decision>(
    [{ text: "Fechar o plano mensal", by: "Participante" }],
    [{ text: "Fechar o plano mensal", by: "Gustavo" }],
    decisionRule,
  );
  assert.equal(decisions[0].by, "Gustavo");
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
