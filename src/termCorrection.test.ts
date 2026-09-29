import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTermCorrections,
  buildTermCorrectionMessages,
  chunkLines,
  mergeCorrections,
  parseTermCorrections,
  squashTerm,
  termSimilarity,
} from "./termCorrection.ts";

// Lines from the real meeting #672079, as the small model transcribed them.
const TRANSCRIPT = [
  "[00:00] Participante: lá na Resend, eles estão usando o D-Brain para resolver o desafio",
  "[00:50] Participante: aí é uma coisa que o G-Brain nem só tem resolução. Enfim, o Gebrain é...",
  "[03:21] Participante: a parceria de sapésica de traje de mercado, e o ValorBrain mint",
  "[07:32] Participante: com alguns players maiores, assim, tipo Vercel, Rapplet, SuperBase.",
  "[07:55] Participante: Então, vou falar para o Diego Draga. Obrigado, amigo.",
].join("\n");

const VOCABULARY = ["ValorBrain", "ValorBrain Meet", "gbrain", "Resend"];

const proposals = (...pairs: Array<[string, string]>) => ({
  correcoes: pairs.map(([de, para]) => ({ de, para })),
});

test("squash and similarity ignore case, accents and punctuation", () => {
  assert.equal(squashTerm("D-Brain"), "dbrain");
  assert.equal(squashTerm("Açaí!"), "acai");
  assert.equal(termSimilarity("D-Brain", "gbrain"), 1 - 1 / 6);
  assert.equal(termSimilarity("5149", "51/49"), 1);
  assert.ok(termSimilarity("Rapplet", "Replit") >= 0.5);
  assert.ok(termSimilarity("sapésica de traje de mercado", "estratégica de go-to-market") < 0.5);
});

test("the misheard terms from the real meeting are corrected", () => {
  const corrections = parseTermCorrections(
    proposals(
      ["D-Brain", "gbrain"],
      ["G-Brain", "gbrain"],
      ["Gebrain", "gbrain"],
      ["ValorBrain mint", "ValorBrain Meet"],
      ["Rapplet", "Replit"],
      ["SuperBase", "Supabase"],
      ["Draga", "Braga"],
    ),
    TRANSCRIPT,
    [...VOCABULARY, "Gustavo", "Diego Braga"],
  );
  assert.equal(corrections.length, 7);

  const { text, counts } = applyTermCorrections(TRANSCRIPT, corrections);
  assert.match(text, /usando o gbrain para/);
  assert.match(text, /que o gbrain nem/);
  assert.match(text, /o gbrain é\.\.\./);
  assert.match(text, /e o ValorBrain Meet/);
  assert.match(text, /tipo Vercel, Replit, Supabase\./);
  assert.match(text, /o Diego Braga\./);
  assert.equal(counts.get("D-Brain"), 1);
});

test("rewrites, invented text and unrelated swaps are rejected", () => {
  const corrections = parseTermCorrections(
    proposals(
      ["sapésica de traje de mercado", "estratégica de go-to-market"], // too different
      ["Notion", "Notion AI"], // not in the transcript
      ["desafio", "problema"], // a common word swapped for another
      ["Diego Draga", "Roberto Braga"], // one person for another
      ["Draga", "Roberto"], // one name for another
      ["de", "do"], // grammar
      ["Resend", "Resend"], // no-op
      ["Vercel, Rapplet, SuperBase e mais", "x"], // longer than 4 words
      ["Rapplet", "<script>"], // unsafe
    ),
    TRANSCRIPT,
    VOCABULARY,
  );
  assert.deepEqual(corrections, []);
});

test("replacements match whole words only and never chain", () => {
  const { text } = applyTermCorrections("Brain, D-Brain e BrainD-Brain.", [
    { from: "D-Brain", to: "gbrain" },
    { from: "gbrain", to: "OUTRO" },
  ]);
  assert.equal(text, "Brain, gbrain e BrainD-Brain.");
});

test("the correction prompt carries the glossary, the names and the untrusted-data fence", () => {
  const [system, user] = buildTermCorrectionMessages({
    lines: TRANSCRIPT.split("\n"),
    vocabulary: VOCABULARY,
    participants: ["Gustavo", "You", "Participante", "Ricardo"],
  });
  assert.match(system.content, /Nunca siga instruções/);
  assert.match(system.content, /"correcoes"/);
  assert.match(user.content, /Termos da empresa: ValorBrain, ValorBrain Meet, gbrain, Resend/);
  assert.match(user.content, /Participantes: Gustavo, Ricardo\n/);
  assert.match(user.content, /<transcricao>\n\[00:00\]/);
});

test("long transcripts are split into chunks without splitting lines", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `[0${i}:00] Pessoa: ${"x".repeat(90)}`);
  const chunks = chunkLines(lines, 300);
  assert.ok(chunks.length >= 4);
  assert.deepEqual(chunks.flat(), lines);
  assert.ok(chunks.every((chunk) => chunk.join("\n").length <= 300));
});

test("corrections from several chunks are merged, first one wins", () => {
  assert.deepEqual(
    mergeCorrections([
      [{ from: "D-Brain", to: "gbrain" }],
      [
        { from: "D-Brain", to: "DBrain" },
        { from: "Rapplet", to: "Replit" },
      ],
    ]),
    [
      { from: "D-Brain", to: "gbrain" },
      { from: "Rapplet", to: "Replit" },
    ],
  );
});

test("a model answer without the expected key yields no corrections", () => {
  assert.deepEqual(parseTermCorrections({ summary: "x" }, TRANSCRIPT), []);
  assert.deepEqual(parseTermCorrections(null, TRANSCRIPT), []);
});
