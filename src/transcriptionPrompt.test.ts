import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_VOCABULARY,
  buildTranscriptionPrompt,
  mergeVocabulary,
  TRANSCRIPTION_PROMPT_MAX_CHARS,
} from "./transcriptionPrompt.ts";

test("the product names are always in the vocabulary, even when the field was saved empty", () => {
  assert.deepEqual(mergeVocabulary(""), BUILTIN_VOCABULARY);
  assert.deepEqual(mergeVocabulary(undefined), BUILTIN_VOCABULARY);
  assert.deepEqual(mergeVocabulary("gbrain, Resend\nvaLORbrain"), [
    "ValorBrain",
    "ValorBrain Meet",
    "gbrain",
    "Resend",
  ]);
});

test("glossary and names come first, then the recent words", () => {
  const prompt = buildTranscriptionPrompt({
    vocabulary: ["ValorBrain", "gbrain"],
    names: ["Gustavo", "You", "Ricardo", "gustavo", "Participante"],
    recentText: "vamos falar da parceria com a Resend",
  });
  assert.equal(
    prompt,
    "Termos: ValorBrain, gbrain. Participantes: Gustavo, Ricardo. vamos falar da parceria com a Resend",
  );
});

test("a long recent text is trimmed from the start; the glossary is never cut", () => {
  const vocabulary = mergeVocabulary(
    "gbrain, Resend, Replit, Supabase, Vercel, go-to-market, equity, valuation, pricing, webinar",
  );
  const recentText = "palavra ".repeat(300) + "fim da última frase";
  const prompt = buildTranscriptionPrompt({ vocabulary, names: ["Gustavo"], recentText });
  assert.ok(prompt.length <= TRANSCRIPTION_PROMPT_MAX_CHARS, `length ${prompt.length}`);
  assert.ok(prompt.startsWith("Termos: ValorBrain, ValorBrain Meet, gbrain,"));
  assert.ok(prompt.includes("webinar."));
  assert.ok(prompt.includes("Participantes: Gustavo."));
  assert.ok(prompt.endsWith("fim da última frase"));
  assert.ok(!/ alavra|^alavra/.test(prompt), "starts the recent text at a word boundary");
});

test("names are capped so they cannot crowd out the recent text", () => {
  const names = Array.from({ length: 30 }, (_, i) => `Pessoa Número ${i + 1}`);
  const prompt = buildTranscriptionPrompt({ vocabulary: [], names, recentText: "e aí" });
  const listed = prompt.match(/Participantes: (.*?)\./)![1].split(", ");
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
  assert.deepEqual(terms.slice(0, 4), ["ValorBrain", "ValorBrain Meet", "gbrain", "Resend"]);
  assert.ok(terms.includes("Supabase"));
  assert.ok(!terms.includes("Erick"), "a graph term is never split on its commas");
  assert.ok(terms.join(", ").length <= 60);
});
