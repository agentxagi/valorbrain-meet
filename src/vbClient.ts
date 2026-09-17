// ValorBrain ingest client (#vb-ingest). Transport + payload assembly for
// pushing saved meeting sessions into a tenant's ValorBrain memory.
//
// Protocol decision (Gus): REST, never MCP — this client targets systems.
// No URL, token, or tenant is ever hardcoded; everything comes from the
// user-configured `vb.*` settings keys.

import { State } from "./types";

// ---------------------------------------------------------------------------
// Settings (`vb.*` keys inside the shared `settings` object)
// ---------------------------------------------------------------------------

export const VB_BASE_URL_KEY = "vb.baseUrl";
export const VB_API_TOKEN_KEY = "vb.apiToken";
export const VB_TENANT_ID_KEY = "vb.tenantId";
export const VB_AUTO_SEND_KEY = "vb.autoSend";

/** Local badge key (chrome.storage.local) holding the last sync outcome. */
export const VB_SYNC_STATUS_KEY = "vbLastSync";

export interface VbSettings {
  /** Base URL of the ValorBrain engine, e.g. https://memory.valor.digital. */
  baseUrl: string;
  /** Bearer token issued to the tenant. */
  apiToken: string;
  /** Tenant UUID. */
  tenantId: string;
  /** Auto-send saved sessions to ValorBrain (default OFF). */
  autoSend: boolean;
}

/** Defaults are intentionally empty — nothing hardcoded, nothing pre-pointed. */
export const DEFAULT_VB_SETTINGS: VbSettings = {
  baseUrl: "",
  apiToken: "",
  tenantId: "",
  autoSend: false,
};

/**
 * Extracts the `vb.*` keys from a raw settings bag, trimming strings and
 * dropping a trailing slash from the base URL. Unknown/invalid values fall
 * back to defaults.
 */
export function normalizeVbSettings(raw: unknown): VbSettings {
  const source = (raw ?? {}) as Record<string, unknown>;

  const rawBaseUrl = typeof source[VB_BASE_URL_KEY] === "string" ? source[VB_BASE_URL_KEY] : "";
  const rawToken = typeof source[VB_API_TOKEN_KEY] === "string" ? source[VB_API_TOKEN_KEY] : "";
  const rawTenant = typeof source[VB_TENANT_ID_KEY] === "string" ? source[VB_TENANT_ID_KEY] : "";

  return {
    baseUrl: rawBaseUrl.trim().replace(/\/+$/, ""),
    apiToken: rawToken.trim(),
    tenantId: rawTenant.trim(),
    autoSend: source[VB_AUTO_SEND_KEY] === true,
  };
}

/** Reads and normalizes the ValorBrain settings from chrome.storage.local. */
export async function getVbSettings(): Promise<VbSettings> {
  const result = await chrome.storage.local.get("settings");
  return normalizeVbSettings(result.settings);
}

export function isVbConfigured(settings: VbSettings): boolean {
  return Boolean(settings.baseUrl && settings.apiToken && settings.tenantId);
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

export const VB_STORE_PATH = "/api/v1/memory/store";
export const VB_HEALTH_PATH = "/health";

export interface VbMemoryPayload {
  type: "observation";
  title: string;
  content: string;
  collection: "meetings";
  tags: string[];
  confidence: number;
}

/** Formats a timestamp as `YYYY-MM-DD HH:mm` in local time. */
export function formatMeetingTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Formats elapsed seconds as `MM:SS` or `HH:MM:SS`. */
export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/**
 * Best-effort call title from the saved session. Sessions carry the Meet
 * identifier (or URL), not a human title — use whatever is most specific.
 */
export function resolveSessionTitle(session: State): string {
  if (session.meetingId) return session.meetingId;
  if (session.meetingUrl) return session.meetingUrl;
  return "Google Meet";
}

/** Builds the `Reunião: <title> (YYYY-MM-DD HH:mm)` memory title. */
export function buildValorBrainTitle(session: State): string {
  const when = session.savedAt || session.startTime || Date.now();
  return `Reunião: ${resolveSessionTitle(session)} (${formatMeetingTimestamp(when)})`;
}

/**
 * Builds the memory content: the existing summary (generated elsewhere —
 * this module only transports it) under `## Resumo`, followed by decisions,
 * action items, and the full transcript. PT-BR section labels per the PRD.
 */
export function buildValorBrainContent(session: State): string {
  const lines: string[] = [];

  lines.push("## Resumo");
  lines.push(session.summary?.trim() ? session.summary.trim() : "_(sem resumo)_");
  lines.push("");

  lines.push("## Decisões");
  const decisions = (session.decisions ?? []).filter((d) => d?.text);
  if (decisions.length > 0) {
    for (const d of decisions) {
      lines.push(`- ${d.text}${d.by ? ` — ${d.by}` : ""}`);
    }
  } else {
    lines.push("_(nenhuma)_");
  }
  lines.push("");

  lines.push("## Action Items");
  const actions = (session.actionItems ?? []).filter((a) => a?.task);
  if (actions.length > 0) {
    for (const a of actions) {
      let item = `- [ ] ${a.task}`;
      if (a.owner) item += ` — ${a.owner}`;
      if (a.deadline) item += ` (prazo: ${a.deadline})`;
      lines.push(item);
    }
  } else {
    lines.push("_(nenhum)_");
  }
  lines.push("");

  lines.push("## Transcript");
  const entries = session.transcript ?? [];
  if (entries.length > 0) {
    for (const entry of entries) {
      if (!entry?.text) continue;
      const label = entry.timestampLabel || formatElapsedSeconds(entry.timestamp || 0);
      lines.push(`[${label}] ${entry.speaker}: ${entry.text}`);
    }
  } else {
    lines.push("_(sem transcrição)_");
  }

  return lines.join("\n");
}

/** Builds the exact REST payload for POST /api/v1/memory/store. */
export function buildValorBrainPayload(session: State): VbMemoryPayload {
  return {
    type: "observation",
    title: buildValorBrainTitle(session),
    content: buildValorBrainContent(session),
    collection: "meetings",
    tags: ["reuniao", "meet", "valorbrain-meet"],
    confidence: 0.85,
  };
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type VbErrorKind = "config" | "auth" | "rateLimit" | "network" | "timeout" | "server";

export interface VbFailure {
  ok: false;
  kind: VbErrorKind;
  error: string;
  /** Whether the caller may retry the same request later. */
  retryable: boolean;
}

export interface VbSuccess {
  ok: true;
  /** `path` or `docid` from the store response, when present. */
  docRef: string | null;
}

export type VbSendResult = VbSuccess | VbFailure;

function failure(kind: VbErrorKind, error: string, retryable = false): VbFailure {
  return { ok: false, kind, error, retryable };
}

/** Extracts `path` or `docid` from a store response body, whichever exists. */
export function extractDocRef(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.path === "string" && record.path) return record.path;
  if (typeof record.path === "number") return String(record.path);
  if (typeof record.docid === "string" && record.docid) return record.docid;
  if (typeof record.docid === "number") return String(record.docid);
  return null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const VB_TIMEOUT_MS = 30_000;
export const VB_RETRY_BACKOFF_MS = 2_000;

export interface VbRequestOptions {
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Wait before the single 429 retry (default 2s). */
  backoffMs?: number;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

interface RawOutcome {
  response?: Response;
  failure?: VbFailure;
}

async function attemptRequest(
  url: URL,
  init: RequestInit,
  options: VbRequestOptions,
): Promise<RawOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? VB_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url.toString(), { ...init, signal: controller.signal });
    return { response };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { failure: failure("timeout", "ValorBrain request timed out", true) };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { failure: failure("network", `Could not reach ValorBrain: ${message}`, true) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyResponse(response: Response): VbFailure | null {
  if (response.status === 401 || response.status === 403) {
    return failure(
      "auth",
      "ValorBrain rejected the credentials (HTTP " +
        response.status +
        ") — check vb.apiToken and vb.tenantId",
    );
  }
  if (response.ok) return null;
  if (response.status === 429) {
    return failure("rateLimit", "ValorBrain rate limit reached (HTTP 429)", true);
  }
  return failure(
    "server",
    `ValorBrain responded with HTTP ${response.status}`,
    response.status >= 500,
  );
}

async function parseJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Sends a saved session to the ValorBrain tenant memory.
 *
 * Error contract:
 * - missing config → `config` failure (no request is made)
 * - 401/403 → `auth` failure (invalid token/tenant)
 * - 429 → one retry after `backoffMs`; persistent 429 → `rateLimit` failure
 * - abort after `timeoutMs` → `timeout` failure
 * - any other non-2xx → `server` failure
 * Never throws; always resolves to a `VbSendResult`.
 */
export async function sendToValorBrain(
  session: State,
  settings: VbSettings,
  options: VbRequestOptions = {},
): Promise<VbSendResult> {
  if (!isVbConfigured(settings)) {
    return failure(
      "config",
      "ValorBrain is not configured — fill in Base URL, API token, and Tenant ID in Settings",
    );
  }
  if (!session) {
    return failure("config", "No meeting session to send");
  }

  let url: URL;
  try {
    url = new URL(VB_STORE_PATH, settings.baseUrl);
  } catch {
    return failure("config", `Invalid ValorBrain Base URL: ${settings.baseUrl}`);
  }

  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiToken}`,
      "X-Tenant-ID": settings.tenantId,
    },
    body: JSON.stringify(buildValorBrainPayload(session)),
  };

  let outcome = await attemptRequest(url, init, options);
  let verdict = outcome.failure ?? classifyResponse(outcome.response!);
  if (verdict?.kind === "rateLimit") {
    // Single retry with backoff before giving up.
    const backoffMs = options.backoffMs ?? VB_RETRY_BACKOFF_MS;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, backoffMs);
    await promise;
    outcome = await attemptRequest(url, init, options);
    verdict = outcome.failure ?? classifyResponse(outcome.response!);
  }
  if (verdict) return verdict;

  const body = await parseJsonBody(outcome.response!);
  return { ok: true, docRef: extractDocRef(body) };
}

export interface VbTestResult {
  ok: boolean;
  message: string;
}

/**
 * Performs GET `{baseUrl}/health` with the auth headers to validate the
 * configured ValorBrain connection. Returns a human-readable outcome.
 */
export async function testValorBrainConnection(
  settings: VbSettings,
  options: VbRequestOptions = {},
): Promise<VbTestResult> {
  if (!isVbConfigured(settings)) {
    return {
      ok: false,
      message: "Fill in Base URL, API token, and Tenant ID before testing",
    };
  }

  let url: URL;
  try {
    url = new URL(VB_HEALTH_PATH, settings.baseUrl);
  } catch {
    return { ok: false, message: `Invalid Base URL: ${settings.baseUrl}` };
  }

  const init: RequestInit = {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiToken}`,
      "X-Tenant-ID": settings.tenantId,
    },
  };
  const outcome = await attemptRequest(url, init, options);
  if (outcome.failure) return { ok: false, message: outcome.failure.error };

  const classified = classifyResponse(outcome.response!);
  if (classified) return { ok: false, message: classified.error };

  return { ok: true, message: `Connected to ${settings.baseUrl}` };
}

// ---------------------------------------------------------------------------
// Sync badge
// ---------------------------------------------------------------------------

export interface VbSyncStatus {
  ok: boolean;
  at: number;
  sessionId?: string;
  docRef?: string | null;
  error?: string;
}

/** Persists the last sync outcome for the dashboard badge (local storage). */
export async function recordVbSyncStatus(result: VbSendResult, sessionId?: string): Promise<void> {
  const status: VbSyncStatus = result.ok
    ? { ok: true, at: Date.now(), sessionId, docRef: result.docRef }
    : { ok: false, at: Date.now(), sessionId, error: result.error };
  await chrome.storage.local.set({ [VB_SYNC_STATUS_KEY]: status });
}
