// Provider-agnostic API helpers for Meeting Copilot

import type { ProviderConfig } from "./providerSettings";

// ── Helper Functions ───────────────────────────────────────────────────────

/**
 * Retries a `fetch` call with exponential backoff on transient failures.
 *
 * Retries are triggered on HTTP 429 (Too Many Requests) and any 5xx server
 * error. Network-level errors (e.g. offline) also trigger a retry. All other
 * non-OK statuses are returned as-is without retrying.
 *
 * @param url - The URL to fetch.
 * @param options - Standard `RequestInit` options passed directly to `fetch`.
 * @param retries - Maximum number of retry attempts after the initial request (default: `3`).
 * @param backoff - Initial delay in milliseconds before the first retry; doubles on each
 *   subsequent attempt (default: `1000`).
 * @returns A resolved `Response` once a request succeeds or a non-retryable status is received.
 * @throws The last caught error if all retry attempts are exhausted.
 *
 * @example
 * const res = await fetchWithRetry(`${providerBaseUrl}/chat/completions`, {
 *   method: "POST",
 *   headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
 *   body: JSON.stringify(payload),
 * });
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  backoff = 1000,
): Promise<Response> {
  try {
    const response = await fetch(url, options);
    // Retry only on 429 (Too Many Requests) or 5xx (Server Errors)
    if (!response.ok && (response.status === 429 || response.status >= 500) && retries > 0) {
      throw new Error(`Status ${response.status}`);
    }
    return response;
  } catch (error) {
    if (retries <= 0) throw error;
    console.warn(`Retrying request to ${url}... (${retries} attempts left)`);
    await new Promise((resolve) => setTimeout(resolve, backoff));
    return fetchWithRetry(url, options, retries - 1, backoff * 2);
  }
}

// ── API Functions ──────────────────────────────────────────────────────────

/**
 * Validates a provider connection by probing the provider's
 * `GET {baseUrl}/models` endpoint (OpenAI wire format). The request times out
 * after 5 seconds.
 *
 * Works for every provider configured in the AI Providers settings — local
 * Whisper servers, Z.ai GLM, OpenAI, or any OpenAI-compatible endpoint. Any
 * HTTP response counts as reachable: some minimal self-hosted servers do not
 * implement `/models` and answer 404, but the transport still works. Only
 * network failures (DNS, refused, timeout) return `false`. The
 * `Authorization` header is only sent when an API key is configured, since
 * self-hosted servers usually require no auth.
 *
 * @param config - The provider block to probe (`baseUrl` + optional `apiKey`).
 * @returns `true` if the endpoint answers with any HTTP response, `false`
 *   otherwise.
 *
 * @example
 * const ok = await validateProviderConnection({ ...zaiConfig, apiKey });
 * if (!ok) showError("Could not reach the summarization provider");
 */
export async function validateProviderConnection(config: ProviderConfig): Promise<boolean> {
  if (!config.baseUrl) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    // Any HTTP status means the host answered — including 404 from minimal
    // whisper servers without a /models route. fetchWithRetry only throws on
    // network-level errors.
    await fetchWithRetry(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    return true;
  } catch (error: unknown) {
    console.error("Provider connection validation failed after retries:", error);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
