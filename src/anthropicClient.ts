/**
 * @fileoverview Claude (Anthropic Messages API) as the summary provider.
 *
 * The rest of the pipeline speaks the OpenAI wire format (providerClient.ts).
 * This module takes the same {@link ChatRequest}, calls Claude through the
 * official SDK and answers with the same {@link ChatResult} and error types, so
 * the service worker's queues, retries, quota handling and PT-BR messages work
 * unchanged. The key is an Anthropic API key from the Claude Console: a Claude
 * Pro/Max subscription cannot be used by other apps.
 *
 * No retries here (maxRetries 0): callers decide, as with the other providers.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ProviderHttpError, ProviderPayloadError } from "./providerErrors";
import type { ChatRequest, ChatResult } from "./providerClient";
import type { ProviderConfig } from "./utils/providerSettings";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Current Claude models always think, and the thinking counts in max_tokens:
 * a limit sized for a model that answers directly would cut the answer.
 */
export const CLAUDE_MIN_MAX_TOKENS = 16_000;

/** Server-side refusal fallback ("default" routing picks the fallback model). */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** True for the Anthropic profile or any block pointed at api.anthropic.com. */
export function isAnthropicProvider(config: Pick<ProviderConfig, "profile" | "baseUrl">): boolean {
  if (config.profile === "anthropic") return true;
  try {
    return new URL(config.baseUrl).host === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** Models that accept `fallbacks: "default"` on the Claude API. */
function acceptsFallback(model: string): boolean {
  return /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
}

/** Models that take `output_config.effort` (older ones answer 400 to it). */
function acceptsEffort(model: string): boolean {
  return /^claude-(opus-4-[6-9]|opus-5|fable-5|sonnet-4-6|sonnet-5|haiku-5)/.test(model);
}

/** The SDK adds /v1/messages itself: a base URL ending in /v1 would double it. */
function sdkBaseUrl(baseUrl: string): string {
  const trimmed = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  return (trimmed || ANTHROPIC_BASE_URL).replace(/\/v1$/, "");
}

/** Turns an SDK failure into the error types the service worker already handles. */
function toProviderError(err: unknown, url: string): unknown {
  if (err instanceof Anthropic.APIUserAbortError) {
    const aborted = new Error("The Claude request was cut short");
    aborted.name = "AbortError";
    return aborted;
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const timedOut = new Error("The Claude request timed out");
    timedOut.name = "TimeoutError";
    return timedOut;
  }
  // A network failure, as fetch reports it (retried by the queues).
  if (err instanceof Anthropic.APIConnectionError) return new TypeError(err.message);
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const body = err.error
      ? JSON.stringify(err.error)
      : JSON.stringify({ error: { message: err.message } });
    return new ProviderHttpError(err.status, body, url);
  }
  return err;
}

/** POST {baseUrl}/v1/messages with the OpenAI-shaped request of the pipeline. */
export async function requestClaudeMessage(
  config: ProviderConfig,
  apiKey: string | null,
  request: ChatRequest,
): Promise<ChatResult> {
  const baseURL = sdkBaseUrl(config.baseUrl);
  const url = `${baseURL}/v1/messages`;
  const timeout = request.timeoutMs ?? 60_000;
  const client = new Anthropic({
    apiKey: apiKey ?? "",
    baseURL,
    // The key is the user's own, typed in Settings and kept in the extension.
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout,
    ...(request.fetchImpl ? { fetch: request.fetchImpl } : {}),
  });

  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages: Anthropic.MessageParam[] = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
  // No temperature: current Claude models answer 400 to sampling parameters.
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.model,
    max_tokens: Math.max(request.maxTokens, CLAUDE_MIN_MAX_TOKENS),
    messages,
    ...(system ? { system } : {}),
    ...(acceptsEffort(config.model) ? { output_config: { effort: request.effort ?? "low" } } : {}),
  };
  const options = { timeout, ...(request.signal ? { signal: request.signal } : {}) };

  let response: Anthropic.Message | Anthropic.Beta.BetaMessage;
  try {
    response = acceptsFallback(config.model)
      ? await client.beta.messages.create(
          {
            ...params,
            betas: [FALLBACK_BETA],
            fallbacks: "default",
          } as Anthropic.Beta.MessageCreateParamsNonStreaming,
          options,
        )
      : await client.messages.create(params, options);
  } catch (err) {
    throw toProviderError(err, url);
  }

  if (response.stop_reason === "refusal") {
    const category = (response as { stop_details?: { category?: string | null } | null })
      .stop_details?.category;
    throw new ProviderPayloadError(
      `O Claude recusou responder a este trecho${category ? ` (${category})` : ""}.`,
    );
  }
  // Text blocks only: thinking and fallback blocks carry no answer.
  const content = (response.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const finishReason = response.stop_reason === "max_tokens" ? "length" : response.stop_reason;
  if (!content.trim()) {
    throw new ProviderPayloadError(
      finishReason === "length"
        ? "O modelo esgotou o limite de tokens antes de responder."
        : "O modelo devolveu uma resposta vazia.",
    );
  }
  const usage = response.usage;
  const promptTokens =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0);
  const completionTokens = usage?.output_tokens ?? 0;
  return {
    content,
    usage: usage
      ? {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        }
      : null,
    finishReason: finishReason ?? null,
  };
}
