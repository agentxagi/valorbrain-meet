/**
 * @fileoverview Provider error model + PT-BR explanations for the UI.
 *
 * STT/LLM helpers throw {@link ProviderHttpError} for non-2xx answers; the
 * service worker turns any thrown value into a short message the user can act
 * on ("Chave recusada…", "Servidor de transcrição fora do ar…").
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

export type ProviderRoleLabel = "transcription" | "summary";

export type ProviderErrorKind =
  | "config"
  | "network"
  | "timeout"
  | "auth"
  | "notFound"
  | "rateLimit"
  | "quota"
  | "badRequest"
  | "server"
  | "parse"
  | "unknown";

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;
  readonly code: string | null;
  readonly providerMessage: string | null;

  constructor(status: number, body: string, url: string) {
    const parsed = parseProviderErrorBody(body);
    super(`HTTP ${status}${parsed.message ? `: ${parsed.message}` : ""}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body.slice(0, 2000);
    this.url = url;
    this.code = parsed.code;
    this.providerMessage = parsed.message;
  }
}

/** Raised when a provider answered 2xx but the payload was unusable. */
export class ProviderPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderPayloadError";
  }
}

/** Raised when the model declined to answer (Claude's "refusal"): asking again gets the same. */
export class ProviderRefusalError extends ProviderPayloadError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRefusalError";
  }
}

/** Raised before any request when the provider block cannot work as configured. */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** Extracts `{code, message}` from OpenAI / Z.ai / Anthropic style error bodies. */
export function parseProviderErrorBody(body: string): {
  code: string | null;
  message: string | null;
} {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = (parsed?.error ?? parsed) as Record<string, unknown>;
    // Anthropic narrows a broad type ("rate_limit_error") down in details.error_code.
    const details = error?.details as Record<string, unknown> | null | undefined;
    const code = details?.error_code ?? error?.code ?? error?.type;
    const message = error?.message ?? error?.detail ?? parsed?.message;
    return {
      code: code === undefined || code === null ? null : String(code),
      message: typeof message === "string" ? message.slice(0, 300) : null,
    };
  } catch {
    const text = body.trim();
    return { code: null, message: text ? text.slice(0, 300) : null };
  }
}

export interface ProviderErrorDescription {
  kind: ProviderErrorKind;
  /** PT-BR sentence for banners/notifications. */
  message: string;
  /** Whether retrying the same request later can succeed. */
  retryable: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function roleNoun(role: ProviderRoleLabel): string {
  return role === "transcription" ? "de transcrição" : "de resumo";
}

/** Z.ai codes that no retry can fix: no balance (1113), usage window exhausted (1308). */
const QUOTA_CODES = new Set(["1113", "1308"]);

/**
 * When a quota renews, as the provider wrote it: Z.ai in China Standard Time
 * ("Your limit will reset at 2026-09-30 04:55:58"), Anthropic in UTC ("You
 * will regain access on 2026-11-01 at 00:00 UTC"). Returns that instant or null.
 */
export function quotaResetAt(message: string | null | undefined): Date | null {
  const match = /(\d{4}-\d{2}-\d{2})(?:[ T]| at )(\d{2}:\d{2}(?::\d{2})?)( UTC)?/.exec(
    String(message ?? ""),
  );
  if (!match) return null;
  const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
  const date = new Date(`${match[1]}T${time}${match[3] ? "Z" : "+08:00"}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUsageWindowExhausted(err: ProviderHttpError): boolean {
  return err.code === "1308" || /usage limit reached|使用上限/i.test(err.providerMessage ?? "");
}

/**
 * Explains an Anthropic refusal that no retry fixes (the organization's
 * monthly spend cap, the usage limit set on the account, no credit left), or
 * returns null for any other failure.
 */
function anthropicQuotaMessage(err: ProviderHttpError): string | null {
  const message = err.providerMessage ?? "";
  if (err.code === "enforced_spend_limit_reached") {
    const resetAt = quotaResetAt(message);
    const when = resetAt
      ? ` O acesso volta em ${resetAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${resetAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`
      : "";
    return `O limite mensal de gastos da sua organização na Anthropic foi atingido.${when}`;
  }
  const noCredit =
    // Anthropic's type: another provider's 402 is not about an Anthropic account.
    (err.status === 402 && err.code === "billing_error") ||
    (err.status === 400 && /credit balance is too low/i.test(message));
  if (noCredit) {
    return "A conta da Anthropic está sem créditos. Adicione créditos em console.anthropic.com.";
  }
  if (err.status === 400 && /reached your specified API usage limits/i.test(message)) {
    return "O limite de uso definido na sua conta da Anthropic foi atingido. Ajuste em console.anthropic.com.";
  }
  return null;
}

/** True for failures worth retrying (network hiccups, 429, 5xx, cold start). */
export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderHttpError) {
    // An exhausted quota never heals by retrying within minutes.
    if (anthropicQuotaMessage(err)) return false;
    if (err.status === 429) return !QUOTA_CODES.has(err.code ?? "") && !isUsageWindowExhausted(err);
    return err.status >= 500 || err.status === 408;
  }
  if (err instanceof ProviderPayloadError) return false;
  if (err instanceof ProviderConfigError) return false;
  if (err instanceof TypeError) return true; // fetch network failure
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return true;
  }
  return false;
}

/**
 * Explains a provider failure in PT-BR.
 *
 * @param role - Which pipeline stage failed.
 * @param err - The thrown value.
 * @param baseUrl - Configured base URL (used to name the host).
 */
export function describeProviderError(
  role: ProviderRoleLabel,
  err: unknown,
  baseUrl = "",
): ProviderErrorDescription {
  const noun = roleNoun(role);
  const host = baseUrl ? hostOf(baseUrl) : "";

  if (err instanceof ProviderHttpError) {
    const detail = err.providerMessage ? ` Detalhe: ${err.providerMessage}` : "";
    if (err.code === "1113") {
      return {
        kind: "quota",
        retryable: false,
        message:
          "A Z.ai recusou por falta de saldo neste endpoint. Se a sua chave é do GLM Coding Plan, use o perfil “Z.ai GLM (GLM Coding Plan)”.",
      };
    }
    const anthropicQuota = anthropicQuotaMessage(err);
    if (anthropicQuota) {
      return {
        kind: "quota",
        retryable: false,
        message: `${anthropicQuota} A transcrição continua normalmente.`,
      };
    }
    if (err.status === 429 && isUsageWindowExhausted(err)) {
      const resetAt = quotaResetAt(err.providerMessage);
      const when = resetAt
        ? ` Ela renova às ${resetAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`
        : " Tente de novo mais tarde.";
      return {
        kind: "quota",
        retryable: false,
        message: `A cota do provedor ${noun} acabou (limite de uso de 5 horas do GLM Coding Plan).${when} A transcrição continua normalmente.`,
      };
    }
    if (err.status === 401 || err.status === 403) {
      return {
        kind: "auth",
        retryable: false,
        message: `O provedor ${noun} recusou a chave de API (HTTP ${err.status}). Confira a chave em Configurações.`,
      };
    }
    if (err.status === 404) {
      return {
        kind: "notFound",
        retryable: false,
        message: `Endpoint ${noun} não encontrado em ${host || "Base URL"} (HTTP 404). Confira a Base URL e o modelo.`,
      };
    }
    if (err.status === 429) {
      return {
        kind: "rateLimit",
        retryable: true,
        message: `O provedor ${noun} limitou as requisições (HTTP 429). Vou tentar de novo em instantes.`,
      };
    }
    if (err.status === 400 || err.status === 422) {
      return {
        kind: "badRequest",
        retryable: false,
        message: `O provedor ${noun} rejeitou a requisição (HTTP ${err.status}).${detail}`,
      };
    }
    return {
      kind: "server",
      retryable: err.status >= 500,
      message: `O provedor ${noun} respondeu com erro (HTTP ${err.status}).${detail}`,
    };
  }

  if (err instanceof ProviderPayloadError) {
    return { kind: "parse", retryable: false, message: err.message };
  }

  if (err instanceof ProviderConfigError) {
    return { kind: "config", retryable: false, message: err.message };
  }

  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return {
      kind: "timeout",
      retryable: true,
      message: `O provedor ${noun}${host ? ` (${host})` : ""} demorou demais para responder.`,
    };
  }

  if (err instanceof TypeError) {
    return {
      kind: "network",
      retryable: true,
      message:
        role === "transcription"
          ? `Não consegui falar com o servidor de transcrição${host ? ` em ${host}` : ""}. Ele está ligado e acessível deste computador?`
          : `Não consegui falar com o provedor de resumo${host ? ` em ${host}` : ""}. Confira a conexão e a Base URL.`,
    };
  }

  const text = err instanceof Error ? err.message : String(err ?? "");
  return {
    kind: "unknown",
    retryable: false,
    message: `Falha no provedor ${noun}${text ? `: ${text.slice(0, 200)}` : "."}`,
  };
}
