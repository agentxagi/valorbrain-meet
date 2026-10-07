/**
 * @fileoverview Tolerant JSON extraction for LLM chat completions.
 *
 * Even with `response_format: json_object`, OpenAI-compatible providers
 * sometimes wrap the object in Markdown fences, prepend reasoning
 * (`<think>…</think>`) or add a sentence before/after it. This helper recovers
 * the first top-level JSON object instead of failing the whole summary.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

export type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tryParse(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Returns the index of the brace closing the object opened at `start`, or -1. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parses an answer that must be one JSON object and nothing else: blank space,
 * one leading reasoning block (`<think>…</think>`, which reasoning models put
 * in the answer itself) and one Markdown code fence around the object are
 * accepted; any other text (a sentence, a second object) is not. For the
 * review of the record, where an object recovered from a longer answer may be
 * the prompt's own example.
 *
 * @returns the parsed object, or `null`.
 */
export function parseJsonObjectStrict(raw: unknown): JsonObject | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .trim()
    .replace(/^<think>[\s\S]*?<\/think>/i, "")
    .trim();
  const fenced = /^```[\w-]*\s*([\s\S]*?)\s*```$/.exec(text);
  return tryParse(fenced ? fenced[1] : text);
}

/**
 * Extracts a JSON object from raw model output.
 *
 * @returns the parsed object, or `null` when no object can be recovered.
 */
export function extractJsonObject(raw: unknown): JsonObject | null {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string") return null;

  const withoutReasoning = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const direct = tryParse(withoutReasoning);
  if (direct) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(withoutReasoning);
  if (fenced) {
    const fromFence = tryParse(fenced[1].trim());
    if (fromFence) return fromFence;
  }

  for (let start = withoutReasoning.indexOf("{"); start !== -1; ) {
    const end = findMatchingBrace(withoutReasoning, start);
    if (end === -1) break;
    const candidate = tryParse(withoutReasoning.slice(start, end + 1));
    if (candidate) return candidate;
    start = withoutReasoning.indexOf("{", start + 1);
  }

  return null;
}
