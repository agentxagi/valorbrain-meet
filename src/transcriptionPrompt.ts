/**
 * @fileoverview The `prompt` sent to Whisper with every audio segment.
 *
 * Whisper reads the prompt as "the text before this audio": spellings in it
 * are copied (company terms, participant names) and the last words give
 * continuity across segments. Whisper keeps only the last ~223 prompt tokens
 * and drops the beginning, so the whole prompt stays within a budget where
 * the glossary is never the part that gets cut: the recent text is trimmed
 * first.
 *
 * The budget is in UTF-8 bytes, not characters: tokens follow bytes much more
 * closely across scripts (about one byte per character in Latin text, two in
 * Cyrillic, Greek or Hebrew, three in Chinese, Japanese and Korean), so a
 * character budget sized for Portuguese overflowed the window in other
 * scripts and cut the glossary off.
 *
 * The prompt carries no labels ("Terms:", "Participantes:"): Whisper treats the
 * prompt as speech, and words in one language nudge it towards that language.
 * Terms and names go in as plain lists.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

import { parseVocabulary, sanitizePromptText } from "./meetingSummary";

/**
 * Terms every meeting gets regardless of the company: none. A brand belongs
 * to the company's own vocabulary (Settings, or the ValorBrain graph), never
 * to the extension, or every customer would get our product name forced into
 * their transcripts.
 */
export const BUILTIN_VOCABULARY: readonly string[] = [];

/** ~600 UTF-8 bytes stay inside Whisper's 223-token prompt window in any script. */
export const TRANSCRIPTION_PROMPT_MAX_BYTES = 600;
const GLOSSARY_MAX_BYTES = 360;
const NAMES_MAX_BYTES = 170;
const MAX_NAMES = 12;

const encoder = new TextEncoder();

/** Size of a text in UTF-8 bytes. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Built-in terms, then the company vocabulary from the settings, then the
 * terms the ValorBrain graph suggested for this meeting. The settings list is
 * the user's own choice and always wins the budget; graph terms fill what is
 * left.
 */
export function mergeVocabulary(
  userVocabulary: unknown,
  maxChars = 300,
  graphTerms: string[] = [],
): string[] {
  const user = typeof userVocabulary === "string" ? userVocabulary : "";
  // A graph term is one term: separators inside it must not split it.
  const graph = graphTerms.map((term) => String(term ?? "").replace(/[,;\n]+/g, " "));
  return parseVocabulary([...BUILTIN_VOCABULARY, user, ...graph].join(", "), maxChars);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = sanitizePromptText(raw, 60);
    const key = name.toLowerCase();
    if (!name || name === "You" || name === "Você" || name === "Participante" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

/** Joins items with ", " while the result fits in `maxBytes`. */
function listWithin(items: string[], maxBytes: number): string {
  let out = "";
  for (const item of items) {
    const next = out ? `${out}, ${item}` : item;
    if (utf8Bytes(next) > maxBytes) break;
    out = next;
  }
  return out;
}

/** The end of `text` that fits in `maxBytes`, starting at a word boundary when there is one. */
function tail(text: string, maxBytes: number): string {
  const clean = sanitizePromptText(text, 4000);
  if (maxBytes <= 0 || !clean) return "";
  if (utf8Bytes(clean) <= maxBytes) return clean;
  const chars = Array.from(clean);
  let start = chars.length;
  let used = 0;
  while (start > 0) {
    const size = utf8Bytes(chars[start - 1]!);
    if (used + size > maxBytes) break;
    used += size;
    start -= 1;
  }
  const cut = chars.slice(start).join("");
  const space = cut.indexOf(" ");
  return (space > 0 && space < 40 ? cut.slice(space + 1) : cut).trim();
}

export interface TranscriptionPromptInput {
  vocabulary: string[];
  names: string[];
  /** What was said right before this segment (same speaker side when known). */
  recentText: string;
  maxBytes?: number;
}

/** `<terms>. <names>. <last words>` within the byte budget, terms first. */
export function buildTranscriptionPrompt(input: TranscriptionPromptInput): string {
  const maxBytes = input.maxBytes ?? TRANSCRIPTION_PROMPT_MAX_BYTES;
  const parts: string[] = [];

  const glossary = listWithin(input.vocabulary, Math.min(GLOSSARY_MAX_BYTES, maxBytes - 1));
  if (glossary) parts.push(`${glossary}.`);

  const names = listWithin(uniqueNames(input.names), NAMES_MAX_BYTES);
  if (names && utf8Bytes([...parts, `${names}.`].join(" ")) <= maxBytes) parts.push(`${names}.`);

  let prompt = parts.join(" ");
  const recent = tail(input.recentText, maxBytes - utf8Bytes(prompt) - 1);
  if (recent) prompt = prompt ? `${prompt} ${recent}` : recent;
  return prompt.trim();
}
