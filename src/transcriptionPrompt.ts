/**
 * @fileoverview The `prompt` sent to Whisper with every audio segment.
 *
 * Whisper reads the prompt as "the text before this audio": spellings in it
 * are copied (company terms, participant names) and the last words give
 * continuity across segments. Whisper keeps only the last ~223 prompt tokens
 * and drops the beginning, so the whole prompt stays within a character budget
 * where the glossary is never the part that gets cut: the recent text is
 * trimmed first.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

import { parseVocabulary, sanitizePromptText } from "./meetingSummary";

/** Product names every meeting may mention, always spelled right. */
export const BUILTIN_VOCABULARY = ["ValorBrain", "ValorBrain Meet"];

/** ~560 characters of PT-BR stay under Whisper's 223-token prompt window. */
export const TRANSCRIPTION_PROMPT_MAX_CHARS = 560;
const NAMES_MAX_CHARS = 160;
const MAX_NAMES = 12;

/** Built-in terms followed by the company vocabulary from the settings. */
export function mergeVocabulary(userVocabulary: unknown, maxChars = 300): string[] {
  const user = typeof userVocabulary === "string" ? userVocabulary : "";
  return parseVocabulary([...BUILTIN_VOCABULARY, user].join(", "), maxChars);
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

/** The last `maxChars` of `text`, starting at a word boundary. */
function tail(text: string, maxChars: number): string {
  const clean = sanitizePromptText(text, 4000);
  if (maxChars <= 0) return "";
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(clean.length - maxChars);
  const space = cut.indexOf(" ");
  return (space > 0 && space < 40 ? cut.slice(space + 1) : cut).trim();
}

export interface TranscriptionPromptInput {
  vocabulary: string[];
  names: string[];
  /** What was said right before this segment (same speaker side when known). */
  recentText: string;
  maxChars?: number;
}

/** `Termos: … Participantes: … <últimas palavras>` within the budget. */
export function buildTranscriptionPrompt(input: TranscriptionPromptInput): string {
  const maxChars = input.maxChars ?? TRANSCRIPTION_PROMPT_MAX_CHARS;
  const parts: string[] = [];
  if (input.vocabulary.length > 0) parts.push(`Termos: ${input.vocabulary.join(", ")}.`);

  let names = "";
  for (const name of uniqueNames(input.names)) {
    const next = names ? `${names}, ${name}` : name;
    if (next.length > NAMES_MAX_CHARS) break;
    names = next;
  }
  if (names) parts.push(`Participantes: ${names}.`);

  let prompt = parts.join(" ").slice(0, maxChars);
  const recent = tail(input.recentText, maxChars - prompt.length - 1);
  if (recent) prompt = prompt ? `${prompt} ${recent}` : recent;
  return prompt.trim();
}
