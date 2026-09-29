import test from "node:test";
import assert from "node:assert/strict";

import {
  makeSilentWav,
  probeChat,
  requestChatCompletion,
  requestTranscription,
} from "./providerClient.ts";
import {
  describeProviderError,
  isRetryableProviderError,
  ProviderConfigError,
  ProviderHttpError,
  ProviderPayloadError,
} from "./providerErrors.ts";
import type { ProviderConfig } from "./utils/providerSettings.ts";

const ZAI: ProviderConfig = {
  profile: "zai-coding",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  apiKey: "k",
  model: "glm-5.3-flash",
};
const LOCAL_STT: ProviderConfig = {
  profile: "whisper-local",
  baseUrl: "http://127.0.0.1:8394/v1",
  apiKey: "",
  model: "whisper-local",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("chat requests disable GLM thinking and ask for JSON on Z.ai", async () => {
  let sent: Record<string, unknown> = {};
  let headers: Record<string, string> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
    sent = JSON.parse(String(init.body));
    headers = init.headers as Record<string, string>;
    return json(200, { choices: [{ message: { content: '{"summary":"ok"}' } }], usage: {} });
  }) as typeof fetch;

  const result = await requestChatCompletion(ZAI, "k", {
    messages: [{ role: "user", content: "oi" }],
    maxTokens: 100,
    json: true,
    fetchImpl,
  });
  assert.equal(result.content, '{"summary":"ok"}');
  assert.deepEqual(sent.thinking, { type: "disabled" });
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.equal(headers.Authorization, "Bearer k");
});

test("custom endpoints get neither GLM thinking nor response_format", async () => {
  let sent: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return json(200, { choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;
  await requestChatCompletion(
    { profile: "custom", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "", model: "llama" },
    null,
    { messages: [], maxTokens: 10, json: true, fetchImpl },
  );
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.response_format, undefined);
});

test("models that cannot disable thinking are retried with low effort", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) {
      return json(400, { error: { code: "1210", message: "cannot be disabled" } });
    }
    return json(200, { choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;
  const answer = await probeChat(ZAI, "k", fetchImpl);
  assert.equal(answer, "ok");
  assert.deepEqual(bodies[1].thinking, { type: "low" });
});

test("an empty answer cut by the token limit is a payload error", async () => {
  const fetchImpl = (async () =>
    json(200, {
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    })) as typeof fetch;
  await assert.rejects(
    requestChatCompletion(ZAI, "k", { messages: [], maxTokens: 5, fetchImpl }),
    (err: unknown) =>
      err instanceof ProviderPayloadError && /limite de tokens/.test((err as Error).message),
  );
});

test("transcription posts multipart with language, temperature and no auth for local servers", async () => {
  let form: FormData | null = null;
  let headers: Record<string, string> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal(url, "http://127.0.0.1:8394/v1/audio/transcriptions");
    form = init.body as FormData;
    headers = init.headers as Record<string, string>;
    return json(200, { text: "olá", duration: 1 });
  }) as typeof fetch;

  const data = await requestTranscription(LOCAL_STT, null, {
    audio: makeSilentWav(0.1),
    filename: "a.wav",
    language: "pt",
    temperature: 0,
    prompt: "Participantes: Ana.",
    fetchImpl,
  });
  assert.equal(data.text, "olá");
  assert.equal(headers.Authorization, undefined);
  assert.equal(form!.get("model"), "whisper-local");
  assert.equal(form!.get("language"), "pt");
  assert.equal(form!.get("temperature"), "0");
  assert.equal(form!.get("response_format"), "verbose_json");
  assert.equal(form!.get("prompt"), "Participantes: Ana.");
});

test("HTTP errors carry status and the provider's error code", async () => {
  const fetchImpl = (async () =>
    json(429, { error: { code: "1113", message: "Insufficient balance" } })) as typeof fetch;
  const err = await requestChatCompletion(ZAI, "k", { messages: [], maxTokens: 5, fetchImpl }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof ProviderHttpError);
  assert.equal(err.status, 429);
  assert.equal(err.code, "1113");
  assert.equal(isRetryableProviderError(err), false, "no balance never heals by retrying");
  assert.match(describeProviderError("summary", err).message, /GLM Coding Plan/);
});

test("describeProviderError explains the common failures in PT-BR", () => {
  const auth = describeProviderError("summary", new ProviderHttpError(401, "{}", "u"));
  assert.equal(auth.kind, "auth");
  assert.match(auth.message, /recusou a chave/);

  const network = describeProviderError(
    "transcription",
    new TypeError("Failed to fetch"),
    "http://127.0.0.1:8394/v1",
  );
  assert.equal(network.kind, "network");
  assert.equal(network.retryable, true);
  assert.match(network.message, /127\.0\.0\.1:8394/);

  const config = describeProviderError("transcription", new ProviderConfigError("Falta a chave."));
  assert.equal(config.kind, "config");
  assert.equal(isRetryableProviderError(new ProviderConfigError("x")), false);
  assert.equal(isRetryableProviderError(new ProviderHttpError(503, "", "u")), true);
});

test("makeSilentWav produces a valid RIFF/WAVE header", async () => {
  const wav = makeSilentWav(1, 16000);
  assert.equal(wav.size, 44 + 32000);
  const header = new TextDecoder().decode(new Uint8Array(await wav.arrayBuffer()).slice(0, 12));
  assert.equal(header.slice(0, 4), "RIFF");
  assert.equal(header.slice(8, 12), "WAVE");
});
