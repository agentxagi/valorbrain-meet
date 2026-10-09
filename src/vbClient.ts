// ValorBrain ingest client (#vb-ingest). Transport + payload assembly for
// pushing saved meeting sessions into a tenant's ValorBrain memory.
//
// Protocol decision (Gus): REST, never MCP — this client targets systems.
// No URL, token, or tenant is ever hardcoded; everything comes from the
// user-configured `vb.*` settings keys.

import { State } from "./types";
import { platformLabelForUrl } from "./platforms";

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
  /** Base URL of the ValorBrain engine API, e.g. https://valorbrain-api.valor.digital. */
  baseUrl: string;
  /** Bearer token issued to the tenant. */
  apiToken: string;
  /** Tenant UUID. */
  tenantId: string;
  /** Auto-send saved sessions to ValorBrain once the connection is configured.
   *  Stored as an intent flag: unset/invalid counts as ON (the default), an
   *  explicit `false` wins. Gate through {@link resolveAutoSend}. */
  autoSend: boolean;
}

/** Defaults are intentionally empty — nothing hardcoded, nothing pre-pointed. */
export const DEFAULT_VB_SETTINGS: VbSettings = {
  baseUrl: "",
  apiToken: "",
  tenantId: "",
  autoSend: true,
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
    autoSend: source[VB_AUTO_SEND_KEY] !== false,
  };
}

/** Reads and normalizes the ValorBrain settings from chrome.storage.local. */
export async function getVbSettings(): Promise<VbSettings> {
  const result = await chrome.storage.local.get("settings");
  return normalizeVbSettings(result.settings);
}

export function isVbConfigured(settings: VbSettings): boolean {
  // Tenant ID is optional: OAuth-issued `vbm_` tokens resolve the tenant
  // server-side, so only the engine URL and a credential are required.
  return Boolean(settings.baseUrl && settings.apiToken);
}

/**
 * Effective auto-send switch: ON by default once the connection is configured
 * (Base URL + token + tenant), OFF otherwise. An explicit stored `false`
 * always wins — the user asked not to auto-send.
 */
export function resolveAutoSend(settings: VbSettings): boolean {
  return isVbConfigured(settings) && settings.autoSend !== false;
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

export const VB_STORE_PATH = "/api/v1/memory/store";
export const VB_HEALTH_PATH = "/health";
/** Endpoint autenticado e barato usado como probe de conexão real. */
export const VB_PROBE_PATH = "/api/v1/memory/working-context";
/**
 * Body of the write probe: a store the engine always refuses (unknown type,
 * no title, no content), so it can tell a token that writes (400, nothing
 * saved) from one that only reads (403, checked before the body).
 */
export const VB_WRITE_PROBE_BODY = { type: "vbmeet-permission-check" } as const;

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
 * Best-effort call title from the saved session: the first discussed topic
 * when the summarizer found one, otherwise the Meet code (or URL).
 */
export function resolveSessionTitle(session: State): string {
  const topic = (session.topics ?? []).find((t) => t?.name?.trim())?.name?.trim();
  if (topic) return topic.slice(0, 120);
  if (session.meetingId && session.meetingId !== "unknown") return session.meetingId;
  if (session.meetingUrl) return session.meetingUrl;
  return platformLabelForUrl(session.meetingUrl);
}

/** Builds the `Reunião: <title> (YYYY-MM-DD HH:mm)` memory title. */
export function buildValorBrainTitle(session: State): string {
  const when = session.startTime || session.savedAt || Date.now();
  return `Reunião: ${resolveSessionTitle(session)} (${formatMeetingTimestamp(when)})`;
}

const TOPIC_STATUS_LABEL: Record<string, string> = {
  active: "em discussão",
  completed: "concluído",
  unresolved: "sem conclusão",
};

function humanParticipants(session: State): string[] {
  return Array.from(
    new Set(
      (session.participants ?? [])
        .map((name) => String(name || "").trim())
        .filter((name) => name && name !== "You"),
    ),
  );
}

/**
 * The terms whose spelling the transcript fixed, by the right spelling only:
 * "gbrain (4), Replit". The misheard forms stay out of the memory: the
 * ValorBrain extracts entities from this text, and "D-Brain" or "Draga" would
 * come back as entities of their own. They live in the graph as aliases
 * (taught after delivery) and in the local session's details.
 */
export function correctedTermsSummary(
  corrections: Array<{ from?: string; to?: string; count?: number }>,
): string {
  const totals = new Map<string, { to: string; count: number }>();
  for (const correction of corrections) {
    const to = String(correction?.to ?? "").trim();
    if (!correction?.from || !to) continue;
    const key = to.toLowerCase();
    const count = Math.max(1, Number(correction.count) || 1);
    const current = totals.get(key);
    if (current) current.count += count;
    else totals.set(key, { to, count });
  }
  return [...totals.values()]
    .slice(0, 20)
    .map(({ to, count }) => (count > 1 ? `${to} (${count})` : to))
    .join(", ");
}

/**
 * Builds the memory content: summary, decisions, next steps, topics, open
 * points, participants, meeting details and the full transcript, all under
 * PT-BR headings.
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
      const tentative = d.classification === "tentative" ? " _(a confirmar)_" : "";
      lines.push(`- ${d.text}${d.by ? ` — ${d.by}` : ""}${tentative}`);
    }
  } else {
    lines.push("_(nenhuma)_");
  }
  lines.push("");

  lines.push("## Próximos passos");
  const actions = (session.actionItems ?? []).filter((a) => a?.task);
  if (actions.length > 0) {
    for (const a of actions) {
      let item = `- [ ] ${a.task}`;
      if (a.owner) item += ` — ${a.owner}`;
      if (a.deadline) item += ` (prazo: ${a.deadline})`;
      if (a.isSpeculative) item += " _(ideia, não confirmada)_";
      lines.push(item);
    }
  } else {
    lines.push("_(nenhum)_");
  }
  lines.push("");

  const topics = (session.topics ?? []).filter((t) => t?.name);
  if (topics.length > 0) {
    lines.push("## Assuntos");
    for (const t of topics) {
      const status = TOPIC_STATUS_LABEL[t.status] ?? "";
      lines.push(`- ${t.name}${status ? ` (${status})` : ""}`);
    }
    lines.push("");
  }

  const openPoints = [
    ...(session.unresolvedDiscussions ?? []),
    ...(session.questionsRaised ?? []),
  ].filter((item) => typeof item === "string" && item.trim());
  if (openPoints.length > 0) {
    lines.push("## Pontos em aberto");
    for (const point of openPoints) lines.push(`- ${point.trim()}`);
    lines.push("");
  }

  const participants = humanParticipants(session);
  if (participants.length > 0) {
    lines.push("## Participantes");
    lines.push(participants.join(", "));
    lines.push("");
  }

  lines.push("## Detalhes");
  const startedAt = session.startTime || session.savedAt;
  if (startedAt) lines.push(`- Início: ${formatMeetingTimestamp(startedAt)}`);
  if (typeof session.duration === "number" && session.duration > 0) {
    lines.push(`- Duração: ${formatElapsedSeconds(session.duration)}`);
  }
  if (session.meetingUrl) lines.push(`- Reunião: ${session.meetingUrl}`);
  else if (session.meetingId) lines.push(`- Reunião: ${session.meetingId}`);
  const corrected = correctedTermsSummary(session.termCorrections ?? []);
  if (corrected) lines.push(`- Grafia revisada na transcrição: ${corrected}`);
  // The version that recorded it (absent on sessions saved before 2.4).
  const version = session.appVersion ? ` ${session.appVersion}` : "";
  lines.push(
    `- Registrado pelo ValorBrain Meet${version} (transcrição automática, pode conter erros)`,
  );
  lines.push("");

  lines.push("## Transcrição");
  const entries = session.transcript ?? [];
  if (entries.length > 0) {
    for (const entry of entries) {
      if (!entry?.text) continue;
      const label = entry.timestampLabel || formatElapsedSeconds(entry.timestamp || 0);
      const speaker = !entry.speaker || entry.speaker === "Audio" ? "Participante" : entry.speaker;
      lines.push(`[${label}] ${speaker}: ${entry.text}`);
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

export interface RawOutcome {
  response?: Response;
  failure?: VbFailure;
}

/** Authorization (+ optional tenant) headers for every ValorBrain REST call. */
export function vbAuthHeaders(settings: VbSettings): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiToken}`,
  };
  // Tenant ID is optional with OAuth-issued tokens; never send an empty header.
  if (settings.tenantId) headers["X-Tenant-ID"] = settings.tenantId;
  return headers;
}

/** One request with a timeout; network errors become a `VbFailure`, never a throw. */
export async function requestValorBrain(
  url: URL,
  init: RequestInit,
  options: VbRequestOptions = {},
): Promise<RawOutcome> {
  return attemptRequest(url, init, options);
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
      return { failure: failure("timeout", "Requisição ao ValorBrain expirou", true) };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      failure: failure("network", `Não foi possível alcançar o ValorBrain: ${message}`, true),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a non-2xx response to the error model (null when the response is OK). */
export function classifyVbResponse(response: Response): VbFailure | null {
  return classifyResponse(response);
}

/** A 401/403 the extension has no better words for. */
function authFailure(status: number): VbFailure {
  return failure(
    "auth",
    `Credenciais rejeitadas pelo ValorBrain (HTTP ${status}) — verifique o token em Configurações → ValorBrain`,
  );
}

function classifyResponse(response: Response): VbFailure | null {
  if (response.status === 401 || response.status === 403) return authFailure(response.status);
  if (response.ok) return null;
  if (response.status === 429) {
    return failure("rateLimit", "ValorBrain atingiu o limite de requisições (HTTP 429)", true);
  }
  return failure(
    "server",
    `ValorBrain respondeu com HTTP ${response.status}`,
    response.status >= 500,
  );
}

/** How long the body of a refusal may take before the generic message is used. */
const VB_REJECTION_BODY_MS = 5_000;

/**
 * A 401/403 with the reason the engine gives in the body. `write` says whether
 * the refused request was a write (a send, or the test's write probe): there
 * the common reason is a token that only reads, since "Conectar com
 * ValorBrain" asked for `read` alone until 2.5.1. The request timer ends with
 * the headers, so the body gets its own deadline.
 */
async function explainRejection(
  response: Response,
  write: boolean,
  options: VbRequestOptions = {},
): Promise<VbFailure> {
  const bodyMs = Math.min(options.timeoutMs ?? VB_REJECTION_BODY_MS, VB_REJECTION_BODY_MS);
  const body = (await readJsonWithin(response, bodyMs)) as {
    error?: unknown;
    code?: unknown;
  } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const error = typeof body?.error === "string" ? body.error : "";
  if (response.status === 403 && code === "insufficient_scope") {
    return failure(
      "auth",
      write
        ? "O token do ValorBrain só tem permissão de leitura, e salvar a reunião é uma gravação. Em Configurações → ValorBrain, clique em Reconectar ou cole um token com permissão de escrita."
        : "O token do ValorBrain não tem permissão para a memória da empresa. Em Configurações → ValorBrain, clique em Reconectar ou cole outro token.",
    );
  }
  if (response.status === 403 && /tenant mismatch/i.test(error)) {
    return failure(
      "auth",
      "O Tenant ID em Configurações → ValorBrain não é o da empresa do token. Apague o Tenant ID: o token já diz qual é a empresa.",
    );
  }
  return authFailure(response.status);
}

/** The JSON body, or null when it is not JSON or has not arrived within `ms`. */
async function readJsonWithin(response: Response, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([parseJsonBody(response), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function parseJsonBody(response: Response): Promise<unknown> {
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
 * - 401/403 → `auth` failure (invalid token/tenant), saying so when the token
 *   only reads or the Tenant ID is another company's
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
      "ValorBrain não configurado — preencha Base URL e token em Configurações → ValorBrain",
    );
  }
  if (!session) {
    return failure("config", "Nenhuma sessão de reunião para enviar");
  }

  let url: URL;
  try {
    url = new URL(VB_STORE_PATH, settings.baseUrl);
  } catch {
    return failure("config", `Base URL do ValorBrain inválida: ${settings.baseUrl}`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiToken}`,
  };
  // Tenant ID is optional with OAuth-issued tokens; never send an empty header.
  if (settings.tenantId) headers["X-Tenant-ID"] = settings.tenantId;

  const init: RequestInit = {
    method: "POST",
    headers,
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
  if (verdict?.kind === "auth" && outcome.response) {
    return explainRejection(outcome.response, true, options);
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
 * Valida a conexão real com o tenant: faz GET `{baseUrl}/api/v1/memory/working-context`
 * (endpoint autenticado e barato) com as credenciais configuradas. Um token
 * inválido retorna 401/403 aqui — diferente de `/health`, que é público.
 * Depois confere a gravação com {@link VB_WRITE_PROBE_BODY}, que o engine
 * sempre recusa sem salvar nada. Retorna um resultado legível para a UI.
 */
export async function testValorBrainConnection(
  settings: VbSettings,
  options: VbRequestOptions = {},
): Promise<VbTestResult> {
  if (!isVbConfigured(settings)) {
    return {
      ok: false,
      message: "Preencha Base URL e token em Configurações → ValorBrain antes de testar",
    };
  }

  let url: URL;
  try {
    url = new URL(VB_PROBE_PATH, settings.baseUrl);
  } catch {
    return { ok: false, message: `Base URL inválida: ${settings.baseUrl}` };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiToken}`,
  };
  if (settings.tenantId) headers["X-Tenant-ID"] = settings.tenantId;

  const init: RequestInit = {
    method: "GET",
    headers,
  };
  const outcome = await attemptRequest(url, init, options);
  if (outcome.failure) return { ok: false, message: outcome.failure.error };

  const classified = classifyResponse(outcome.response!);
  if (classified?.kind === "auth") {
    return {
      ok: false,
      message: (await explainRejection(outcome.response!, false, options)).error,
    };
  }
  if (classified) return { ok: false, message: classified.error };

  // Reading is not enough: saving a meeting is a write, and a token that only
  // reads passes the probe above. The engine checks the scope before the body,
  // so a store it always refuses answers 403 for that token and 400, with
  // nothing saved, for one that writes.
  const probe = await attemptRequest(
    new URL(VB_STORE_PATH, settings.baseUrl),
    { method: "POST", headers, body: JSON.stringify(VB_WRITE_PROBE_BODY) },
    options,
  );
  if (probe.failure) return { ok: false, message: probe.failure.error };
  const refused = classifyResponse(probe.response!);
  if (refused?.kind === "auth") {
    return { ok: false, message: (await explainRejection(probe.response!, true, options)).error };
  }
  const bodyRefused = probe.response!.status === 400 || probe.response!.status === 422;
  if (refused && !bodyRefused) return { ok: false, message: refused.error };

  return { ok: true, message: `Conectado a ${settings.baseUrl} — o token pode salvar reuniões` };
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
