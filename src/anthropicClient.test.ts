import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_MIN_MAX_TOKENS,
  isAnthropicProvider,
  requestClaudeMessage,
} from "./anthropicClient";
import { probeChat, requestChatCompletion, type ChatRequest } from "./providerClient";
import {
  describeProviderError,
  isRetryableProviderError,
  ProviderHttpError,
  ProviderPayloadError,
  quotaResetAt,
} from "./providerErrors";
import type { ProviderConfig } from "./utils/providerSettings";

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const CLAUDE: ProviderConfig = {
  profile: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "",
  model: "claude-opus-5-5",
};

function claudeAnswer(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: '{"summary": "ok"}' },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 50,
    },
    ...overrides,
  };
}

/** A fetch that records each call and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "request-id": "req_test" },
    });
  }) as typeof fetch;
}

function chat(fetchImpl: typeof fetch, extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [
      { role: "system", content: "Você resume reuniões." },
      { role: "user", content: "<transcricao>…</transcricao>" },
    ],
    maxTokens: 4800,
    temperature: 0.2,
    json: true,
    timeoutMs: 30_000,
    fetchImpl,
    ...extra,
  };
}

test("the Anthropic profile and api.anthropic.com go to Claude", () => {
  assert.equal(isAnthropicProvider(CLAUDE), true);
  assert.equal(
    isAnthropicProvider({ profile: "custom", baseUrl: "https://api.anthropic.com/v1" }),
    true,
  );
  assert.equal(
    isAnthropicProvider({ profile: "zai-coding", baseUrl: "https://api.z.ai/api/coding/paas/v4" }),
    false,
  );
  assert.equal(isAnthropicProvider({ profile: "custom", baseUrl: "not a url" }), false);
});

test("a Claude request: Messages API, the key, browser access, thinking room, no sampling", async () => {
  const calls: Call[] = [];
  const result = await requestClaudeMessage(
    CLAUDE,
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer(), calls)),
  );

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(call.headers.get("x-api-key"), "sk-ant-test");
  assert.ok(call.headers.get("anthropic-version"));
  // The SDK marks a call made from a browser context (the extension).
  assert.equal(call.headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(call.headers.get("anthropic-beta"), "server-side-fallback-2026-07-01");

  assert.equal(call.body.model, "claude-opus-5-5");
  assert.equal(call.body.system, "Você resume reuniões.");
  assert.deepEqual(call.body.messages, [{ role: "user", content: "<transcricao>…</transcricao>" }]);
  // The thinking counts in max_tokens: a GLM-sized limit is raised.
  assert.equal(call.body.max_tokens, CLAUDE_MIN_MAX_TOKENS);
  assert.deepEqual(call.body.output_config, { effort: "low" });
  assert.equal(call.body.fallbacks, "default");
  assert.equal("temperature" in call.body, false, "current Claude models refuse sampling params");
  assert.equal("response_format" in call.body, false);

  // Only the text block is the answer; usage adds the cached input.
  assert.equal(result.content, '{"summary": "ok"}');
  assert.equal(result.finishReason, "end_turn");
  assert.deepEqual(result.usage, {
    prompt_tokens: 1050,
    completion_tokens: 200,
    total_tokens: 1250,
  });
});

test("effort is passed as asked, and a large limit is kept", async () => {
  const calls: Call[] = [];
  await requestClaudeMessage(
    CLAUDE,
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer(), calls), { effort: "medium", maxTokens: 20_000 }),
  );
  assert.deepEqual(calls[0].body.output_config, { effort: "medium" });
  assert.equal(calls[0].body.max_tokens, 20_000);
});

test("models without the refusal fallback or effort get neither", async () => {
  const haiku: Call[] = [];
  await requestClaudeMessage(
    { ...CLAUDE, model: "claude-haiku-5-5" },
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer(), haiku)),
  );
  assert.equal(haiku[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(haiku[0].headers.get("anthropic-beta"), null);
  assert.equal("fallbacks" in haiku[0].body, false);
  assert.deepEqual(haiku[0].body.output_config, { effort: "low" });

  const older: Call[] = [];
  await requestClaudeMessage(
    { ...CLAUDE, model: "claude-haiku-4-5" },
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer(), older)),
  );
  assert.equal("output_config" in older[0].body, false, "older models answer 400 to effort");
  assert.equal("fallbacks" in older[0].body, false);
});

test("a base URL ending in /v1 is not doubled", async () => {
  const calls: Call[] = [];
  await requestClaudeMessage(
    { ...CLAUDE, baseUrl: "https://api.anthropic.com/v1/", model: "claude-haiku-5-5" },
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer(), calls)),
  );
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
});

test("a cut answer, a refusal and an empty answer are explained", async () => {
  const cut = await requestClaudeMessage(
    CLAUDE,
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer({ stop_reason: "max_tokens" }), [])),
  );
  assert.equal(cut.finishReason, "length");

  await assert.rejects(
    requestClaudeMessage(
      CLAUDE,
      "sk-ant-test",
      chat(
        fakeFetch(
          200,
          claudeAnswer({
            stop_reason: "refusal",
            stop_details: { type: "refusal", category: "cyber", explanation: "x" },
            content: [],
          }),
          [],
        ),
      ),
    ),
    (err: unknown) => err instanceof ProviderPayloadError && /recusou.*\(cyber\)/.test(err.message),
  );

  await assert.rejects(
    requestClaudeMessage(
      CLAUDE,
      "sk-ant-test",
      chat(
        fakeFetch(
          200,
          claudeAnswer({ content: [{ type: "thinking", thinking: "", signature: "s" }] }),
          [],
        ),
      ),
    ),
    (err: unknown) => err instanceof ProviderPayloadError && /resposta vazia/.test(err.message),
  );
});

test("API errors become the pipeline's own errors (status, code, retry)", async () => {
  const rateLimited = await requestClaudeMessage(
    CLAUDE,
    "sk-ant-test",
    chat(
      fakeFetch(
        429,
        {
          type: "error",
          error: { type: "rate_limit_error", message: "Number of requests exceeded" },
        },
        [],
      ),
    ),
  ).catch((err: unknown) => err);
  assert.ok(rateLimited instanceof ProviderHttpError);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.code, "rate_limit_error");
  assert.equal(rateLimited.providerMessage, "Number of requests exceeded");
  assert.equal(isRetryableProviderError(rateLimited), true);

  const badKey = await requestClaudeMessage(
    CLAUDE,
    "sk-ant-wrong",
    chat(
      fakeFetch(
        401,
        { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        [],
      ),
    ),
  ).catch((err: unknown) => err);
  assert.ok(badKey instanceof ProviderHttpError);
  assert.equal(badKey.status, 401);
  assert.equal(isRetryableProviderError(badKey), false);

  const overloaded = await requestClaudeMessage(
    CLAUDE,
    "sk-ant-test",
    chat(
      fakeFetch(
        529,
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        [],
      ),
    ),
  ).catch((err: unknown) => err);
  assert.ok(overloaded instanceof ProviderHttpError);
  assert.equal(isRetryableProviderError(overloaded), true);
});

test("the spend cap, no credit and the account's usage limit are a quota, not retried", async () => {
  const failure = (status: number, error: Record<string, unknown>) =>
    requestClaudeMessage(
      CLAUDE,
      "sk-ant-test",
      chat(fakeFetch(status, { type: "error", error, request_id: "req_test" }, [])),
    ).catch((err: unknown) => err);

  const capped = await failure(429, {
    type: "rate_limit_error",
    message:
      "Your organization has reached its monthly spend limit. You will regain access on 2026-11-01 at 00:00 UTC.",
    details: { error_code: "enforced_spend_limit_reached" },
  });
  assert.ok(capped instanceof ProviderHttpError);
  assert.equal(capped.code, "enforced_spend_limit_reached");
  assert.equal(isRetryableProviderError(capped), false);
  assert.equal(describeProviderError("summary", capped).kind, "quota");
  assert.equal(quotaResetAt(capped.providerMessage)?.toISOString(), "2026-11-01T00:00:00.000Z");

  for (const [status, error] of [
    [402, { type: "billing_error", message: "Payment required." }],
    [
      400,
      {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    ],
    [
      400,
      {
        type: "invalid_request_error",
        message:
          "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      },
    ],
  ] as const) {
    const err = await failure(status, error);
    assert.ok(err instanceof ProviderHttpError, String(err));
    assert.equal(err.status, status);
    assert.equal(isRetryableProviderError(err), false, error.message);
    assert.equal(describeProviderError("summary", err).kind, "quota", error.message);
  }
});

test("a network failure and an abort keep their meaning", async () => {
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  const network = await requestClaudeMessage(CLAUDE, "sk-ant-test", chat(offline)).catch(
    (err: unknown) => err,
  );
  assert.ok(network instanceof TypeError, String(network));
  assert.equal(isRetryableProviderError(network), true);

  const controller = new AbortController();
  controller.abort();
  const aborted = await requestClaudeMessage(
    CLAUDE,
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer(), []), { signal: controller.signal }),
  ).catch((err: unknown) => err);
  assert.ok(aborted instanceof Error);
  assert.equal(aborted.name, "AbortError");
});

test("the pipeline's chat call and the connection test reach Claude", async () => {
  const calls: Call[] = [];
  const result = await requestChatCompletion(
    CLAUDE,
    "sk-ant-test",
    chat(fakeFetch(200, claudeAnswer(), calls)),
  );
  assert.equal(result.content, '{"summary": "ok"}');
  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);

  const probe: Call[] = [];
  const answer = await probeChat(
    CLAUDE,
    "sk-ant-test",
    fakeFetch(200, claudeAnswer({ content: [{ type: "text", text: " ok " }] }), probe),
  );
  assert.equal(answer, "ok");
  assert.equal(probe[0].body.max_tokens, CLAUDE_MIN_MAX_TOKENS);
});
