import test from "node:test";
import assert from "node:assert/strict";

import {
  anySignal,
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
  quotaResetAt,
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

test("the low-effort retry keeps the first try's deadline and the caller's signal", async () => {
  const signals: AbortSignal[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    if (signals.length === 1) {
      return json(400, { error: { code: "1210", message: "cannot be disabled" } });
    }
    return json(200, { choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;
  const caller = new AbortController();
  await requestChatCompletion(ZAI, "k", {
    messages: [],
    maxTokens: 10,
    timeoutMs: 30_000,
    signal: caller.signal,
    fetchImpl,
  });
  assert.equal(signals.length, 2);
  assert.equal(signals[1], signals[0], "no fresh timeout for the retry");
  caller.abort();
  assert.equal(signals[1].aborted, true, "the caller can still cut it");
});

test("the caller's signal cuts a request short", async () => {
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
  const caller = new AbortController();
  const request = requestChatCompletion(ZAI, "k", {
    messages: [],
    maxTokens: 10,
    signal: caller.signal,
    fetchImpl,
  });
  caller.abort();
  await assert.rejects(request, (err: unknown) => (err as Error).name === "AbortError");
});

test("anySignal aborts with the first of its signals, also without AbortSignal.any", () => {
  const native = AbortSignal.any;
  for (const withAny of [true, false]) {
    if (!withAny) (AbortSignal as { any?: unknown }).any = undefined;
    try {
      const first = new AbortController();
      const second = new AbortController();
      const either = anySignal([first.signal, second.signal]);
      assert.equal(either.aborted, false);
      second.abort("hurry");
      assert.equal(either.aborted, true);
      assert.equal(either.reason, "hurry");
      const done = new AbortController();
      done.abort("before");
      assert.equal(anySignal([new AbortController().signal, done.signal]).reason, "before");
    } finally {
      AbortSignal.any = native;
    }
  }
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
  // Z.ai GLM Coding Plan: the 5-hour usage window is exhausted (seen live).
  const exhausted = new ProviderHttpError(
    429,
    JSON.stringify({
      error: {
        code: "1308",
        message: "Usage limit reached for 5 hour. Your limit will reset at 2026-09-30 04:55:58",
      },
    }),
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
  );
  assert.equal(isRetryableProviderError(exhausted), false, "retrying cannot beat a quota");
  const quota = describeProviderError("summary", exhausted);
  assert.equal(quota.kind, "quota");
  assert.match(quota.message, /cota do provedor de resumo acabou/);
  assert.match(quota.message, /renova às \d{2}:\d{2}/);
  assert.equal(quotaResetAt(exhausted.providerMessage)?.toISOString(), "2026-09-29T20:55:58.000Z");
  assert.equal(quotaResetAt("sem data"), null);
  assert.equal(
    isRetryableProviderError(new ProviderHttpError(429, '{"error":{"message":"slow down"}}', "u")),
    true,
    "a plain rate limit is still retried",
  );

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

test("Anthropic's spend cap, usage limit and missing credit are a quota, never retried", () => {
  const anthropic = (status: number, error: Record<string, unknown>) =>
    new ProviderHttpError(
      status,
      JSON.stringify({ type: "error", error }),
      "https://api.anthropic.com/v1/messages",
    );

  // The organization's monthly spend cap: a 429 that only details.error_code tells apart.
  const capError = {
    type: "rate_limit_error",
    message:
      "Your organization has reached its monthly spend limit. You will regain access on 2026-11-01 at 00:00 UTC.",
    details: { error_code: "enforced_spend_limit_reached" },
  };
  const spendCap = anthropic(429, capError);
  assert.equal(spendCap.code, "enforced_spend_limit_reached");
  assert.equal(isRetryableProviderError(spendCap), false);
  const capped = describeProviderError("summary", spendCap);
  assert.equal(capped.kind, "quota");
  assert.match(
    capped.message,
    /^O limite mensal de gastos da sua organização na Anthropic foi atingido\. O acesso volta em \d{2}\/\d{2} às \d{2}:\d{2}\. A transcrição continua normalmente\.$/,
  );
  // Anthropic writes the time in UTC; Z.ai's has no zone and is China's (above).
  assert.equal(quotaResetAt(spendCap.providerMessage)?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(
    describeProviderError("summary", anthropic(429, { ...capError, message: "Spend limit." }))
      .message,
    "O limite mensal de gastos da sua organização na Anthropic foi atingido. A transcrição continua normalmente.",
  );

  const noCredit =
    "A conta da Anthropic está sem créditos. Adicione créditos em console.anthropic.com. A transcrição continua normalmente.";
  for (const [err, message] of [
    [anthropic(402, { type: "billing_error", message: "Payment required." }), noCredit],
    [
      anthropic(400, {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      }),
      noCredit,
    ],
    [
      anthropic(400, {
        type: "invalid_request_error",
        message:
          "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      }),
      "O limite de uso definido na sua conta da Anthropic foi atingido. Ajuste em console.anthropic.com. A transcrição continua normalmente.",
    ],
  ] as const) {
    assert.equal(isRetryableProviderError(err), false, err.message);
    assert.deepEqual(describeProviderError("summary", err), {
      kind: "quota",
      retryable: false,
      message,
    });
  }

  // A plain rate limit is still retried, and another provider's 402 is not about Anthropic.
  const busy = anthropic(429, { type: "rate_limit_error", message: "Number of requests exceeded" });
  assert.equal(isRetryableProviderError(busy), true);
  assert.equal(describeProviderError("summary", busy).kind, "rateLimit");
  const elsewhere = new ProviderHttpError(
    402,
    JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }),
    "https://openrouter.ai/api/v1/chat/completions",
  );
  assert.doesNotMatch(describeProviderError("summary", elsewhere).message, /Anthropic/);
});

test("makeSilentWav produces a valid RIFF/WAVE header", async () => {
  const wav = makeSilentWav(1, 16000);
  assert.equal(wav.size, 44 + 32000);
  const header = new TextDecoder().decode(new Uint8Array(await wav.arrayBuffer()).slice(0, 12));
  assert.equal(header.slice(0, 4), "RIFF");
  assert.equal(header.slice(8, 12), "WAVE");
});
