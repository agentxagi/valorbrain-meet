import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanTranscription,
  collapseRepeatedPhrases,
  isHardHallucination,
  isNonSpeechMarker,
  normalizeForMatch,
} from "./transcriptFilter.ts";

test("Whisper loops from the real meetings are kept once", () => {
  assert.equal(
    collapseRepeatedPhrases("Ah, entendi. Ah, entendi. Ah, entendi. Ah, entendi. Ah, entendi."),
    "Ah, entendi.",
  );
  assert.equal(
    collapseRepeatedPhrases(
      "Ele foi selecionado na live de 2007. De sete? De sete. De sete. De sete. De sete. Mas é isso.",
    ),
    "Ele foi selecionado na live de 2007. De sete? Mas é isso.",
  );
  assert.equal(collapseRepeatedPhrases("ok ok ok ok ok ok"), "ok");
});

test("real repetitions and emphasis are not collapsed", () => {
  assert.equal(collapseRepeatedPhrases("Não, não, não, espera."), "Não, não, não, espera.");
  assert.equal(collapseRepeatedPhrases("Sim, sim. Fechado."), "Sim, sim. Fechado.");
  assert.equal(
    collapseRepeatedPhrases("Eu acho que sim, eu acho que sim, vamos nessa."),
    "Eu acho que sim, eu acho que sim, vamos nessa.",
  );
  assert.equal(collapseRepeatedPhrases("1, 2, 3, 4"), "1, 2, 3, 4");
});

test("a looping chunk reaches the transcript collapsed", () => {
  const result = cleanTranscription({
    text: "Tô louco. Ah, entendi. Ah, entendi. Ah, entendi. Ah, entendi.",
    segments: [
      {
        text: " Tô louco. Ah, entendi. Ah, entendi. Ah, entendi. Ah, entendi.",
        no_speech_prob: 0.05,
        avg_logprob: -0.4,
        compression_ratio: 1.9,
      },
    ],
  });
  assert.equal(result.text, "Tô louco. Ah, entendi.");
});

test("normalizeForMatch lower-cases, keeps accents and drops punctuation", () => {
  assert.equal(
    normalizeForMatch("  Legendas pela comunidade Amara.org!  "),
    "legendas pela comunidade amara org",
  );
  assert.equal(normalizeForMatch("Decisão: lançar na SEXTA."), "decisão lançar na sexta");
});

test("subtitle-credit hallucinations are recognised anywhere in a sentence", () => {
  assert.equal(isHardHallucination("Legendas pela comunidade Amara.org"), true);
  assert.equal(isHardHallucination("Obrigado por assistir!"), true);
  assert.equal(isHardHallucination("Thanks for watching."), true);
  assert.equal(isHardHallucination("Vamos lançar na sexta-feira."), false);
});

test("music/applause markers and bare punctuation are not speech", () => {
  assert.equal(isNonSpeechMarker("♪ ♪"), true);
  assert.equal(isNonSpeechMarker("[Música]"), true);
  assert.equal(isNonSpeechMarker("..."), true);
  assert.equal(isNonSpeechMarker("Sim."), false);
});

test("keeps real speech from a verbose_json response", () => {
  const result = cleanTranscription({
    text: "Bom dia. A decisão é lançar na sexta.",
    duration: 6.2,
    segments: [
      { text: " Bom dia.", no_speech_prob: 0.01, avg_logprob: -0.2 },
      { text: " A decisão é lançar na sexta.", no_speech_prob: 0.01, avg_logprob: -0.2 },
    ],
  });
  assert.equal(result.text, "Bom dia. A decisão é lançar na sexta.");
  assert.equal(result.durationSec, 6.2);
  assert.equal(result.reason, undefined);
});

test("speech start is the first kept segment, not a dropped hallucination", () => {
  const result = cleanTranscription({
    text: "Obrigado. Vamos começar.",
    duration: 20,
    segments: [
      { text: " Obrigado.", start: 0.4, no_speech_prob: 0.7, avg_logprob: -1.2 },
      { text: " Vamos começar.", start: 6.5, no_speech_prob: 0.02, avg_logprob: -0.2 },
    ],
  });
  assert.equal(result.text, "Vamos começar.");
  assert.equal(result.speechStartSec, 6.5);
  assert.equal(cleanTranscription({ text: "Oi." }).speechStartSec, undefined);
});

test("drops credits glued to real speech but keeps the speech", () => {
  const result = cleanTranscription({
    text: "Vamos fechar o orçamento. Legendas pela comunidade Amara.org",
  });
  assert.equal(result.text, "Vamos fechar o orçamento.");
  assert.equal(result.dropped.length, 1);
});

test("drops segments Whisper itself scores as silence", () => {
  const result = cleanTranscription({
    text: "Obrigado.",
    segments: [{ text: " Obrigado.", no_speech_prob: 0.82, avg_logprob: -1.3 }],
  });
  assert.equal(result.text, "");
  assert.equal(result.reason, "low-confidence");
});

test("a confident short 'Obrigado.' is kept (it is a legit meeting utterance)", () => {
  const result = cleanTranscription({
    text: "Obrigado.",
    segments: [{ text: " Obrigado.", no_speech_prob: 0.02, avg_logprob: -0.15 }],
  });
  assert.equal(result.text, "Obrigado.");
});

test("an uncertain short 'Obrigado.' is treated as a silence hallucination", () => {
  const result = cleanTranscription({
    text: "Obrigado.",
    segments: [{ text: " Obrigado.", no_speech_prob: 0.35, avg_logprob: -0.5 }],
  });
  assert.equal(result.text, "");
  assert.equal(result.reason, "hallucination");
});

test("an exact repeat of a recent long entry is a loop, not new speech", () => {
  const previous = "Precisamos revisar a página de preços antes do lançamento.";
  const result = cleanTranscription({ text: previous }, ["Outro assunto.", previous]);
  assert.equal(result.text, "");
  assert.equal(result.reason, "repeat");

  const short = cleanTranscription({ text: "Sim." }, ["Sim."]);
  assert.equal(short.text, "Sim.");
});

test("empty responses report the empty reason", () => {
  assert.equal(cleanTranscription({ text: "" }).reason, "empty");
  assert.equal(cleanTranscription(null).reason, "empty");
  assert.equal(cleanTranscription({ text: "  ", segments: [] }).text, "");
});
