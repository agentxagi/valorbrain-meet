/**
 * @fileoverview The company's own vocabulary, from the ValorBrain graph, for
 * the transcription, and the way back: spelling fixes accepted in a meeting
 * become aliases in the graph, so the next meeting starts right.
 *
 *   GET  /api/v1/meet/vocabulary?participants=Ana,Bruno&limit=40
 *        → { terms: [{term, kind, reason}], corrections: [{from, to}], participants }
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
  foldTerm,
  isSafeKnownCorrection,
  learnableCorrections,
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

  const corrections: TermCorrection[] = [];
  const seenFrom = new Set<string>();
  for (const item of Array.isArray(record.corrections) ? record.corrections : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const from = typeof entry.from === "string" ? entry.from.replace(/\s+/g, " ").trim() : "";
    const to = typeof entry.to === "string" ? entry.to.replace(/\s+/g, " ").trim() : "";
    if (!isSafeKnownCorrection(from, to, names)) continue;
    const key = foldTerm(from);
    if (seenFrom.has(key)) continue;
    seenFrom.add(key);
    corrections.push({ from, to });
    if (corrections.length >= MAX_CORRECTIONS) break;
  }

  return { terms, corrections, fetchedAt: now, participantsKey: participantsKey(names) };
}

/**
 * Asks the tenant graph for the vocabulary of this meeting. Never throws; a
 * missing endpoint (older engine) comes back as a `server` failure.
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
  if (names.length > 0) url.searchParams.set("participants", names.join(","));
  url.searchParams.set("limit", String(options.limit ?? VOCABULARY_LIMIT));

  const outcome = await requestValorBrain(
    url,
    { method: "GET", headers: vbAuthHeaders(settings) },
    { ...options, timeoutMs: options.timeoutMs ?? VOCABULARY_TIMEOUT_MS },
  );
  if (outcome.failure) return outcome.failure;
  const verdict = classifyVbResponse(outcome.response!);
  if (verdict) return verdict;
  const body = await parseJsonBody(outcome.response!);
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
