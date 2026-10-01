import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_LANGUAGE_LOCK,
  inLanguagePhrase,
  isAutoLanguage,
  joinerFallbackMessage,
  meetingLanguageTag,
  normalizeLanguageCode,
  observeLanguage,
  outputLanguageRule,
  sttLanguage,
  wordCountAnyScript,
} from "./meetingLanguage.ts";

test("language codes come from codes, tags or Whisper's language names", () => {
  assert.equal(normalizeLanguageCode("pt"), "pt");
  assert.equal(normalizeLanguageCode("pt-BR"), "pt");
  assert.equal(normalizeLanguageCode("Portuguese"), "pt");
  assert.equal(normalizeLanguageCode("japanese"), "ja");
  assert.equal(normalizeLanguageCode("zh_Hant"), "zh");
  for (const bad of ["", "auto?", 42, null, "not a language"]) {
    assert.equal(normalizeLanguageCode(bad), null, String(bad));
  }
});

test("no setting, an empty one or 'auto' means detection", () => {
  assert.equal(isAutoLanguage(undefined), true);
  assert.equal(isAutoLanguage(""), true);
  assert.equal(isAutoLanguage("auto"), true);
  assert.equal(isAutoLanguage("pt"), false);
});

test("one segment with enough speech locks the language by itself", () => {
  const lock = observeLanguage(
    EMPTY_LANGUAGE_LOCK,
    "portuguese",
    "Bom dia, pessoal. A decisão é lançar a versão 2 na sexta.",
  );
  assert.equal(lock.locked, "pt");
});

test("short segments lock only when two agree; a disagreement starts over", () => {
  let lock = observeLanguage(EMPTY_LANGUAGE_LOCK, "en", "yes let's go");
  assert.equal(lock.locked, null);
  lock = observeLanguage(lock, "gl", "sim vamos lá");
  assert.equal(lock.locked, null);
  assert.equal(lock.candidate, "gl");
  lock = observeLanguage(lock, "pt", "certo, combinado então");
  assert.equal(lock.locked, null);
  lock = observeLanguage(lock, "pt", "então eu preparo isso");
  assert.equal(lock.locked, "pt");
  // Locked stays locked.
  assert.equal(
    observeLanguage(lock, "en", "a long english sentence that would otherwise lock").locked,
    "pt",
  );
});

test("dropped or tiny segments never vote", () => {
  assert.equal(observeLanguage(EMPTY_LANGUAGE_LOCK, "en", ""), EMPTY_LANGUAGE_LOCK);
  assert.equal(observeLanguage(EMPTY_LANGUAGE_LOCK, "en", "thank you"), EMPTY_LANGUAGE_LOCK);
  assert.equal(
    observeLanguage(EMPTY_LANGUAGE_LOCK, undefined, "a sentence without a detection here"),
    EMPTY_LANGUAGE_LOCK,
  );
});

test("words are counted in scripts without spaces (Japanese, Chinese)", () => {
  assert.ok(wordCountAnyScript("今日は新しい機能について話しましょう") >= 5);
  const lock = observeLanguage(
    EMPTY_LANGUAGE_LOCK,
    "japanese",
    "今日は新しい機能について話しましょう。来週リリースします。",
  );
  assert.equal(lock.locked, "ja");
});

test("what goes to Whisper: the fixed setting, else the lock, else nothing", () => {
  const locked = { locked: "es", candidate: "es", votes: 2 };
  assert.equal(sttLanguage("pt", locked), "pt");
  assert.equal(sttLanguage("pt-BR", EMPTY_LANGUAGE_LOCK), "pt");
  assert.equal(sttLanguage("auto", locked), "es");
  assert.equal(sttLanguage(undefined, EMPTY_LANGUAGE_LOCK), undefined);
});

test("the meeting language takes the browser's region when the language matches", () => {
  const pt = { locked: "pt", candidate: "pt", votes: 1 };
  assert.equal(meetingLanguageTag("auto", pt, "pt-BR"), "pt-BR");
  assert.equal(meetingLanguageTag("auto", pt, "en-US"), "pt");
  assert.equal(meetingLanguageTag("en", EMPTY_LANGUAGE_LOCK, "pt-BR"), "en");
  assert.equal(meetingLanguageTag("auto", EMPTY_LANGUAGE_LOCK, "pt-BR"), null);
});

test("the instructions name the language, or follow the transcript when it is unknown", () => {
  assert.match(outputLanguageRule("en"), /Escreva sempre em inglês/);
  assert.match(outputLanguageRule("pt-BR"), /português \(Brasil\)/);
  assert.match(outputLanguageRule(null), /no idioma em que a reunião acontece/);
  assert.equal(inLanguagePhrase("es"), "em espanhol");
  assert.equal(inLanguagePhrase(null), "no idioma da reunião");
});

test("the late-joiner greeting falls back to the meeting language (English when unknown)", () => {
  assert.equal(
    joinerFallbackMessage("pt-BR", "Ana", "o lançamento"),
    "Olá, Ana! Boas-vindas à reunião. Agora estamos falando sobre o lançamento.",
  );
  assert.equal(
    joinerFallbackMessage("es", "Ana", ""),
    "¡Hola, Ana! Te damos la bienvenida a la reunión.",
  );
  assert.equal(
    joinerFallbackMessage("ja", "Ana", "pricing"),
    "Hi Ana, welcome to the meeting! We are now talking about pricing.",
  );
  assert.equal(joinerFallbackMessage(null, "Ana", ""), "Hi Ana, welcome to the meeting!");
});
