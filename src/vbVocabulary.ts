/**
 * @fileoverview The company's own vocabulary, from the ValorBrain graph, for
 * the transcription, and the way back: spelling fixes accepted in a meeting
 * become aliases in the graph, so the next meeting starts right.
 *
 *   POST /api/v1/meet/vocabulary  { participants: ["Ana", "Bruno"], limit: 40 }
 *        → { terms: [{term, kind, reason}], corrections: [{from, to}], participants }
 *        (names go in the body, never in a URL that access logs keep; an engine
 *        without the POST route gets a GET without names)
 *   POST /api/v1/meet/aliases  { aliases: [{ from, to }] }
 *        → { recorded: [...], skipped: [...] }
 *
 * The engine only counts documents the connected account can see, never
 * merges entities from an alias, and refuses aliases for established names.
 * This client adds its own lock on what it applies (isSafeKnownCorrection).
 *
 * Pure except for `fetch` (injectable): unit-tested in node.
 */

import { sanitizePromptText } from "./meetingSummary";
import type { GraphVocabulary } from "./types";
import {
  dropCorrectionCycles,
  foldTerm,
  isSafeKnownCorrection,
  learnableCorrections,
  nameVariants,
  squashTerm,
  type TermCorrection,
} from "./termCorrection";
import {
  classifyVbResponse,
  isVbConfigured,
  parseJsonBody,
  requestValorBrain,
  vbAuthHeaders,
  type VbFailure,
  type VbRequestOptions,
  type VbSettings,
} from "./vbClient";

export const VB_VOCABULARY_PATH = "/api/v1/meet/vocabulary";
export const VB_ALIASES_PATH = "/api/v1/meet/aliases";
/** The recording never waits for it; a slow engine just means no graph terms. */
export const VOCABULARY_TIMEOUT_MS = 8_000;
export const VOCABULARY_LIMIT = 40;
export const MAX_ALIASES_PER_REQUEST = 50;
/**
 * Requests per recording and the spacing between them (first one at the
 * start, the others when new people join). Mutable only for tests.
 */
export const vocabularyTiming = { maxFetches: 4, refreshMinMs: 30_000 };
const MAX_TERMS = 120;
const MAX_CORRECTIONS = 200;
const MAX_PARTICIPANTS = 20;

/** Meet's placeholders for people without a name. */
const PLACEHOLDER_NAME = /^(you|você|voce|participante|participant|audio)$/i;

export type { GraphVocabulary };

export type VocabularyResult = { ok: true; vocabulary: GraphVocabulary } | VbFailure;

export type AliasesResult = { ok: true; recorded: number; skipped: number } | VbFailure;

function configFailure(error: string): VbFailure {
  return { ok: false, kind: "config", error, retryable: false };
}

/** Real names only, prompt-safe, no separators (the engine splits on commas). */
export function vocabularyParticipants(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = sanitizePromptText(raw, 80).replace(/,/g, " ").replace(/\s+/g, " ").trim();
    const key = foldTerm(name);
    if (!name || PLACEHOLDER_NAME.test(name) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_PARTICIPANTS) break;
  }
  return out;
}

/** Order-insensitive key of a participant list. */
export function participantsKey(names: string[]): string {
  return vocabularyParticipants(names).map(foldTerm).sort().join("|");
}

/** Validates the engine's answer; anything malformed is dropped, never applied. */
export function parseVocabularyResponse(
  body: unknown,
  participants: string[],
  now = Date.now(),
): GraphVocabulary {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const names = vocabularyParticipants(participants);
  const nameKeys = new Set(names.map(foldTerm));
  const protectedNames = nameVariants(names);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of Array.isArray(record.terms) ? record.terms : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const term = sanitizePromptText(entry.term, 60);
    const key = foldTerm(term);
    if (term.length < 2 || !key || seen.has(key)) continue;
    if (entry.reason === "participant" || nameKeys.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }

  const knownTerms = new Set(terms.map(squashTerm));
  const candidates: TermCorrection[] = [];
  const seenFrom = new Set<string>();
  for (const item of Array.isArray(record.corrections) ? record.corrections : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const from = typeof entry.from === "string" ? entry.from.replace(/\s+/g, " ").trim() : "";
    const to = typeof entry.to === "string" ? entry.to.replace(/\s+/g, " ").trim() : "";
    if (!isSafeKnownCorrection(from, to, [], knownTerms)) continue;
    const key = foldTerm(from);
    if (seenFrom.has(key)) continue;
    seenFrom.add(key);
    candidates.push({ from, to });
    if (candidates.length >= MAX_CORRECTIONS) break;
  }
  // Cycles are a property of the whole alias set (A → B with B → A swaps
  // names), so they go before the per-meeting name protection.
  const corrections = dropCorrectionCycles(candidates).filter(
    (c) => !protectedNames.has(squashTerm(c.from)),
  );

  return { terms, corrections, fetchedAt: now, participantsKey: participantsKey(names) };
}

/** The body read with a deadline: a stalled response never holds the caller. */
async function readJsonWithin(response: Response, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([parseJsonBody(response), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the tenant graph for the vocabulary of this meeting. Never throws. The
 * participant names travel in a POST body; an engine without that route
 * (404/405) is asked again by GET, without names (terms and learned fixes
 * still come, only the participant-first ranking is lost).
 */
export async function fetchMeetVocabulary(
  settings: VbSettings,
  participants: string[],
  options: VbRequestOptions & { limit?: number } = {},
): Promise<VocabularyResult> {
  if (!isVbConfigured(settings)) return configFailure("ValorBrain não configurado");

  let url: URL;
  try {
    url = new URL(VB_VOCABULARY_PATH, settings.baseUrl);
  } catch {
    return configFailure(`Base URL do ValorBrain inválida: ${settings.baseUrl}`);
  }
  const names = vocabularyParticipants(participants);
  const limit = options.limit ?? VOCABULARY_LIMIT;
  const timeoutMs = options.timeoutMs ?? VOCABULARY_TIMEOUT_MS;

  let outcome = await requestValorBrain(
    url,
    {
      method: "POST",
      headers: vbAuthHeaders(settings),
      body: JSON.stringify({ participants: names, limit }),
    },
    { ...options, timeoutMs },
  );
  if (outcome.response && (outcome.response.status === 404 || outcome.response.status === 405)) {
    const legacy = new URL(url);
    legacy.searchParams.set("limit", String(limit));
    outcome = await requestValorBrain(
      legacy,
      { method: "GET", headers: vbAuthHeaders(settings) },
      { ...options, timeoutMs },
    );
  }
  if (outcome.failure) return outcome.failure;
  const verdict = classifyVbResponse(outcome.response!);
  if (verdict) return verdict;
  const body = await readJsonWithin(outcome.response!, timeoutMs);
  return { ok: true, vocabulary: parseVocabularyResponse(body, names) };
}

/**
 * Teaches the graph the fixes the final review accepted in this meeting
 * (`learnableCorrections`: learned ones are not sent back). The engine decides
 * which become aliases; the counts come from its answer.
 */
export async function recordMeetAliases(
  settings: VbSettings,
  corrections: Array<TermCorrection & { count?: number; source?: string }>,
  options: VbRequestOptions = {},
): Promise<AliasesResult> {
  const aliases = learnableCorrections(corrections).slice(0, MAX_ALIASES_PER_REQUEST);
  if (aliases.length === 0) return { ok: true, recorded: 0, skipped: 0 };
  if (!isVbConfigured(settings)) return configFailure("ValorBrain não configurado");

  let url: URL;
  try {
    url = new URL(VB_ALIASES_PATH, settings.baseUrl);
  } catch {
    return configFailure(`Base URL do ValorBrain inválida: ${settings.baseUrl}`);
  }
  const outcome = await requestValorBrain(
    url,
    { method: "POST", headers: vbAuthHeaders(settings), body: JSON.stringify({ aliases }) },
    { ...options, timeoutMs: options.timeoutMs ?? VOCABULARY_TIMEOUT_MS },
  );
  if (outcome.failure) return outcome.failure;
  const verdict = classifyVbResponse(outcome.response!);
  if (verdict) return verdict;
  const body = (await parseJsonBody(outcome.response!)) as Record<string, unknown> | null;
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return { ok: true, recorded: count(body?.recorded), skipped: count(body?.skipped) };
}
