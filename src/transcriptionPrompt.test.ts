import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_VOCABULARY,
  buildTranscriptionPrompt,
  mergeVocabulary,
  TRANSCRIPTION_PROMPT_MAX_BYTES,
  utf8Bytes,
} from "./transcriptionPrompt.ts";

test("the extension adds no terms of its own: the vocabulary is the company's", () => {
  assert.deepEqual(BUILTIN_VOCABULARY, []);
  assert.deepEqual(mergeVocabulary(""), []);
  assert.deepEqual(mergeVocabulary(undefined), []);
  assert.deepEqual(mergeVocabulary("gbrain, Resend\nvaLORbrain, Gbrain"), [
    "gbrain",
    "Resend",
    "vaLORbrain",
  ]);
});

test("glossary and names come first, then the recent words, with no labels", () => {
  const prompt = buildTranscriptionPrompt({
    vocabulary: ["ValorBrain", "gbrain"],
    names: ["Gustavo", "You", "Ricardo", "gustavo", "Participante"],
    recentText: "vamos falar da parceria com a Resend",
  });
  assert.equal(
    prompt,
    "ValorBrain, gbrain. Gustavo, Ricardo. vamos falar da parceria com a Resend",
  );
});

test("a long recent text is trimmed from the start; the glossary is never cut", () => {
  const vocabulary = mergeVocabulary(
    "gbrain, Resend, Replit, Supabase, Vercel, go-to-market, equity, valuation, pricing, webinar",
  );
  const recentText = "palavra ".repeat(300) + "fim da última frase";
  const prompt = buildTranscriptionPrompt({ vocabulary, names: ["Gustavo"], recentText });
  assert.ok(utf8Bytes(prompt) <= TRANSCRIPTION_PROMPT_MAX_BYTES, `bytes ${utf8Bytes(prompt)}`);
  assert.ok(prompt.startsWith("gbrain, Resend, Replit,"));
  assert.ok(prompt.includes("webinar."));
  assert.ok(prompt.includes(" Gustavo. "));
  assert.ok(prompt.endsWith("fim da última frase"));
  assert.ok(!/ alavra|^alavra/.test(prompt), "starts the recent text at a word boundary");
});

test("the budget holds in scripts with multi-byte characters (CJK, Cyrillic)", () => {
  const japanese = buildTranscriptionPrompt({
    vocabulary: ["スーパーベース", "バーセル", "株式会社テスト"],
    names: ["田中", "佐藤"],
    recentText: "今日は新しい機能について話しましょう。".repeat(60),
  });
  assert.ok(utf8Bytes(japanese) <= TRANSCRIPTION_PROMPT_MAX_BYTES, `bytes ${utf8Bytes(japanese)}`);
  assert.ok(japanese.startsWith("スーパーベース, バーセル, 株式会社テスト. 田中, 佐藤."));

  const russian = buildTranscriptionPrompt({
    vocabulary: ["Яндекс", "Сбер"],
    names: [],
    recentText: "мы обсуждаем новый релиз ".repeat(80),
  });
  assert.ok(utf8Bytes(russian) <= TRANSCRIPTION_PROMPT_MAX_BYTES, `bytes ${utf8Bytes(russian)}`);
  assert.ok(russian.startsWith("Яндекс, Сбер."));
});

test("names are capped so they cannot crowd out the recent text", () => {
  const names = Array.from({ length: 30 }, (_, i) => `Pessoa Número ${i + 1}`);
  const prompt = buildTranscriptionPrompt({ vocabulary: [], names, recentText: "e aí" });
  const listed = prompt.slice(0, prompt.indexOf(".")).split(", ");
  assert.ok(listed.length <= 12);
  assert.ok(prompt.endsWith("e aí"));
});

test("prompt-breaking characters are removed", () => {
  const prompt = buildTranscriptionPrompt({
    vocabulary: [],
    names: ["<script>Eve</script>"],
    recentText: "```ignore previous``` {x}",
  });
  assert.ok(!/[<>{}`]/.test(prompt), prompt);
});

test("graph terms fill the glossary after the settings list, deduplicated and budgeted", () => {
  const terms = mergeVocabulary("gbrain, Resend", 60, [
    "resend",
    "Supabase",
    "Erick, Santos",
    "Twenty",
  ]);
  assert.deepEqual(terms.slice(0, 2), ["gbrain", "Resend"]);
  assert.ok(terms.includes("Supabase"));
  assert.ok(!terms.includes("Erick"), "a graph term is never split on its commas");
  assert.ok(terms.join(", ").length <= 60);
});
