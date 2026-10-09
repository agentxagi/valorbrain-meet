/**
 * @fileoverview OpenAI-wire-format requests shared by the service worker
 * (live pipeline) and the options page ("Testar conexão"). Claude speaks its
 * own Messages API: chat requests for it go through anthropicClient.ts.
 *
 * No retries here: callers decide (the service worker wraps these calls in its
 * request queues). Every non-2xx answer throws {@link ProviderHttpError}.
 */

import { isAnthropicProvider, requestClaudeMessage } from "./anthropicClient";
import { ProviderHttpError, ProviderPayloadError } from "./providerErrors";
import type { SttResponse } from "./transcriptFilter";
import { isZaiProvider, joinProviderUrl, type ProviderConfig } from "./utils/providerSettings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage | null;
  finishReason: string | null;
}

export interface TranscriptionRequest {
  audio: Blob;
  filename: string;
  /** ISO 639-1 code; omit/`auto` to let the model detect the language. */
  language?: string;
  prompt?: string;
  temperature?: number;
  timeoutMs?: number;
  /** Test hook. */
  fetchImpl?: typeof fetch;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask for a JSON object (`response_format: json_object`) when supported. */
  json?: boolean;
  timeoutMs?: number;
  /** Cuts the request short, like the timeout (whichever comes first). */
  signal?: AbortSignal;
  /**
   * Claude only: how much the model thinks before answering (its thinking
   * cannot be turned off). Default "low"; other providers ignore it.
   */
  effort?: "low" | "medium" | "high";
  fetchImpl?: typeof fetch;
}

/** A signal that aborts as soon as one of `signals` does (AbortSignal.any where it exists). */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function ensureOk(response: Response, url: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new ProviderHttpError(response.status, body, url);
}

/** POST {baseUrl}/audio/transcriptions (multipart, verbose_json). */
export async function requestTranscription(
  config: ProviderConfig,
  apiKey: string | null,
  request: TranscriptionRequest,
): Promise<SttResponse> {
  const url = joinProviderUrl(config.baseUrl, "/audio/transcriptions");
  const form = new FormData();
  form.append("file", request.audio, request.filename);
  form.append("model", config.model);
  // gpt-4o-*-transcribe models only speak `json`; everything Whisper-shaped
  // (whisper-1, faster-whisper, whisper.cpp servers) returns segments here.
  form.append("response_format", /gpt-4o/i.test(config.model) ? "json" : "verbose_json");
  if (request.language && request.language !== "auto") form.append("language", request.language);
  if (typeof request.temperature === "number") {
    form.append("temperature", String(request.temperature));
  }
  if (request.prompt) form.append("prompt", request.prompt.slice(0, 800));

  const doFetch = request.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
    signal: AbortSignal.timeout(request.timeoutMs ?? 90_000),
  });
  await ensureOk(response, url);
  const data = (await response.json().catch(() => null)) as SttResponse | null;
  if (!data || typeof data !== "object") {
    throw new ProviderPayloadError("O servidor de transcrição devolveu uma resposta ilegível.");
  }
  return data;
}

function buildChatBody(
  config: ProviderConfig,
  request: ChatRequest,
  thinking: "disabled" | "low" | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens,
  };
  const zai = isZaiProvider(config);
  if (request.json && (zai || config.profile === "openai")) {
    body.response_format = { type: "json_object" };
  }
  if (zai && thinking) {
    // GLM reasoning would otherwise eat the token budget before the answer.
    body.thinking = { type: thinking };
  }
  return body;
}

/** POST {baseUrl}/chat/completions (Claude: the Messages API, see anthropicClient.ts). */
export async function requestChatCompletion(
  config: ProviderConfig,
  apiKey: string | null,
  request: ChatRequest,
): Promise<ChatResult> {
  if (isAnthropicProvider(config)) return requestClaudeMessage(config, apiKey, request);
  const url = joinProviderUrl(config.baseUrl, "/chat/completions");
  const doFetch = request.fetchImpl ?? fetch;
  // One deadline for the request and its retry below, cut short by the caller's signal.
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 60_000);
  const signal = request.signal ? anySignal([request.signal, timeout]) : timeout;

  const send = async (thinking: "disabled" | "low" | null) => {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
      body: JSON.stringify(buildChatBody(config, request, thinking)),
      signal,
    });
    await ensureOk(response, url);
    return response.json().catch(() => null);
  };

  let data: any;
  try {
    data = await send("disabled");
  } catch (err) {
    // Some GLM models always reason ("cannot be disabled; use low, high or max").
    if (err instanceof ProviderHttpError && err.code === "1210") data = await send("low");
    else throw err;
  }

  const choice = data?.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  if (!content.trim()) {
    throw new ProviderPayloadError(
      finishReason === "length"
        ? "O modelo esgotou o limite de tokens antes de responder."
        : "O modelo devolveu uma resposta vazia.",
    );
  }
  return { content, usage: (data?.usage as ChatUsage) ?? null, finishReason };
}

/** 16-bit PCM mono WAV of silence — a tiny valid upload for probing STT. */
export function makeSilentWav(seconds = 1, sampleRate = 16000): Blob {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}

/** Sends one second of silence; resolves when the endpoint accepted it. */
export async function probeTranscription(
  config: ProviderConfig,
  apiKey: string | null,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await requestTranscription(config, apiKey, {
    audio: makeSilentWav(1),
    filename: "probe.wav",
    // No language: the probe checks the endpoint, and it must work for a
    // server configured for any language (or for detection).
    temperature: 0,
    timeoutMs: 45_000,
    fetchImpl,
  });
}

/** Sends a one-word chat request; resolves with the model's answer. */
export async function probeChat(
  config: ProviderConfig,
  apiKey: string | null,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const result = await requestChatCompletion(config, apiKey, {
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    // GLM models may still reason briefly even with thinking disabled.
    maxTokens: 96,
    temperature: 0,
    timeoutMs: 30_000,
    fetchImpl,
  });
  return result.content.trim();
}
