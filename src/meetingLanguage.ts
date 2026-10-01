/**
 * @fileoverview The language of the meeting: the one fixed in the settings,
 * or the one Whisper detects, locked once it is clear.
 *
 * Whisper detects the language per segment. A short or noisy segment can come
 * back as another language, and a recording sent with no language at all can
 * flip between languages from one segment to the next. So detection locks:
 * once one segment carries enough speech, or two segments agree, that is the
 * meeting language and the following segments are sent with it. The lock
 * lives for one recording.
 *
 * The same language drives every text the extension writes for the meeting
 * (summary, briefing for late joiners, spelling review), so nothing assumes
 * the meeting is in Portuguese.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

/**
 * Whisper language names (OpenAI's verbose_json answers "portuguese";
 * faster-whisper servers answer "pt"), from Whisper's own tokenizer table.
 */
const WHISPER_LANGUAGE_NAMES: Record<string, string> = {
  afrikaans: "af",
  arabic: "ar",
  armenian: "hy",
  azerbaijani: "az",
  belarusian: "be",
  bengali: "bn",
  bosnian: "bs",
  bulgarian: "bg",
  catalan: "ca",
  chinese: "zh",
  croatian: "hr",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  estonian: "et",
  finnish: "fi",
  french: "fr",
  galician: "gl",
  german: "de",
  greek: "el",
  hebrew: "he",
  hindi: "hi",
  hungarian: "hu",
  icelandic: "is",
  indonesian: "id",
  italian: "it",
  japanese: "ja",
  kannada: "kn",
  kazakh: "kk",
  korean: "ko",
  latvian: "lv",
  lithuanian: "lt",
  macedonian: "mk",
  malay: "ms",
  marathi: "mr",
  nepali: "ne",
  norwegian: "no",
  persian: "fa",
  polish: "pl",
  portuguese: "pt",
  romanian: "ro",
  russian: "ru",
  serbian: "sr",
  slovak: "sk",
  slovenian: "sl",
  spanish: "es",
  swahili: "sw",
  swedish: "sv",
  tagalog: "tl",
  tamil: "ta",
  thai: "th",
  turkish: "tr",
  ukrainian: "uk",
  urdu: "ur",
  vietnamese: "vi",
  welsh: "cy",
};

/** `"pt"`, `"pt-BR"`, `"Portuguese"` → `"pt"`; anything else → null. */
export function normalizeLanguageCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (WHISPER_LANGUAGE_NAMES[value]) return WHISPER_LANGUAGE_NAMES[value];
  const match = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/.exec(value);
  return match ? match[1]! : null;
}

/** True when the setting asks for detection (absent, empty or "auto"). */
export function isAutoLanguage(setting: unknown): boolean {
  return typeof setting !== "string" || !setting.trim() || setting.trim().toLowerCase() === "auto";
}

export interface LanguageLock {
  locked: string | null;
  candidate: string | null;
  votes: number;
}

export const EMPTY_LANGUAGE_LOCK: LanguageLock = Object.freeze({
  locked: null,
  candidate: null,
  votes: 0,
}) as LanguageLock;

/** One segment with at least this many words locks the language by itself. */
export const LOCK_SINGLE_SEGMENT_WORDS = 8;
/** Below this many words a detection does not count at all. */
export const LOCK_MIN_WORDS = 3;

/**
 * Words in a text, in any script: `Intl.Segmenter` splits Chinese, Japanese
 * and Thai, which have no spaces between words.
 */
export function wordCountAnyScript(text: string): number {
  const value = String(text || "").trim();
  if (!value) return 0;
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    let count = 0;
    for (const part of new Segmenter(undefined, { granularity: "word" }).segment(value)) {
      if (part.isWordLike) count += 1;
    }
    return count;
  }
  return value.split(/\s+/).filter(Boolean).length;
}

/**
 * Feeds one transcribed segment into the lock. `keptText` is what survived
 * the hallucination filter: a dropped segment never votes.
 */
export function observeLanguage(
  lock: LanguageLock,
  detected: unknown,
  keptText: string,
): LanguageLock {
  if (lock.locked) return lock;
  const code = normalizeLanguageCode(detected);
  const words = wordCountAnyScript(keptText);
  if (!code || words < LOCK_MIN_WORDS) return lock;
  if (words >= LOCK_SINGLE_SEGMENT_WORDS) return { locked: code, candidate: code, votes: 1 };
  if (lock.candidate === code) {
    return lock.votes + 1 >= 2
      ? { locked: code, candidate: code, votes: lock.votes + 1 }
      : { ...lock, votes: lock.votes + 1 };
  }
  return { locked: null, candidate: code, votes: 1 };
}

/** What to send as Whisper's `language`: the fixed setting, else the lock, else nothing (detect). */
export function sttLanguage(setting: unknown, lock: LanguageLock): string | undefined {
  if (!isAutoLanguage(setting)) return normalizeLanguageCode(setting) ?? undefined;
  return lock.locked ?? undefined;
}

/**
 * The meeting language as a BCP-47 tag for the texts the extension writes:
 * the setting (keeping its region, "pt-BR"), else the locked detection. A
 * bare language picks up the region of the browser when they match, so a
 * meeting detected as "pt" on a pt-BR browser is written as pt-BR.
 */
export function meetingLanguageTag(
  setting: unknown,
  lock: LanguageLock,
  browserLocale?: string | null,
): string | null {
  let tag: string | null = null;
  if (!isAutoLanguage(setting)) {
    tag = String(setting).trim().replace("_", "-");
    if (!normalizeLanguageCode(tag)) tag = null;
  }
  if (!tag) tag = lock.locked;
  if (!tag) return null;
  if (!tag.includes("-") && browserLocale) {
    const browser = String(browserLocale).trim().replace("_", "-");
    if (normalizeLanguageCode(browser) === tag && browser.includes("-")) return browser;
  }
  return tag;
}

/** "pt-BR" → "português (Brasil)" in the locale of the instructions (pt-BR). */
export function languageDisplayName(tag: string, displayLocale = "pt-BR"): string {
  try {
    const names = new Intl.DisplayNames([displayLocale], { type: "language" });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The output-language sentence of the summary instructions. */
export function outputLanguageRule(tag: string | null): string {
  return tag
    ? `Escreva sempre em ${languageDisplayName(tag)}, em tom profissional e direto.`
    : "Escreva no idioma em que a reunião acontece (o mesmo da transcrição), em tom profissional e direto.";
}

/** "em inglês" / "no idioma da reunião", for instructions that name the language once. */
export function inLanguagePhrase(tag: string | null): string {
  return tag ? `em ${languageDisplayName(tag)}` : "no idioma da reunião";
}

const JOINER_FALLBACK: Record<string, { withTopic: string; noTopic: string }> = {
  pt: {
    withTopic: "Olá, {name}! Boas-vindas à reunião. Agora estamos falando sobre {topic}.",
    noTopic: "Olá, {name}! Boas-vindas à reunião.",
  },
  en: {
    withTopic: "Hi {name}, welcome to the meeting! We are now talking about {topic}.",
    noTopic: "Hi {name}, welcome to the meeting!",
  },
  es: {
    withTopic: "¡Hola, {name}! Te damos la bienvenida a la reunión. Ahora hablamos de {topic}.",
    noTopic: "¡Hola, {name}! Te damos la bienvenida a la reunión.",
  },
};

/**
 * The greeting sent to a late joiner when the model cannot write one, in the
 * meeting language (English when the language has no template, or is unknown).
 */
export function joinerFallbackMessage(tag: string | null, name: string, topic: string): string {
  const lang = normalizeLanguageCode(tag) ?? "en";
  const template = JOINER_FALLBACK[lang] ?? JOINER_FALLBACK.en!;
  const text = topic.trim() ? template.withTopic : template.noTopic;
  return text.replace("{name}", name).replace("{topic}", topic.trim());
}
