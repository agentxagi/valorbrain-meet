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

/** Raised before any request when the provider block cannot work as configured. */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** Extracts `{code, message}` from OpenAI / Z.ai style error bodies. */
export function parseProviderErrorBody(body: string): {
  code: string | null;
  message: string | null;
} {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = (parsed?.error ?? parsed) as Record<string, unknown>;
    const code = error?.code ?? error?.type;
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

/** True for failures worth retrying (network hiccups, 429, 5xx, cold start). */
export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderHttpError) {
    if (err.status === 429) return err.code !== "1113"; // Z.ai "no balance" never heals
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
