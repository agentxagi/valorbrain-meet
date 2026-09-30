import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchMeetVocabulary,
  parseVocabularyResponse,
  participantsKey,
  recordMeetAliases,
  vocabularyParticipants,
} from "./vbVocabulary.ts";
import type { VbSettings } from "./vbClient.ts";

const SETTINGS: VbSettings = {
  baseUrl: "https://valorbrain-api.valor.digital",
  apiToken: "vbm_test",
  tenantId: "",
  autoSend: true,
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The shape GET /api/v1/meet/vocabulary answered in production (29/09). */
const ENGINE_ANSWER = {
  terms: [
    { term: "Erick", kind: "person", reason: "participant" },
    { term: "ValorBrain", kind: "project", reason: "related" },
    { term: "gbrain", kind: "tool", reason: "meeting" },
    { term: "Resend", kind: "service", reason: "related" },
    { term: "resend", kind: "service", reason: "related" },
    { term: "<b>Stripe</b>", kind: "org", reason: "frequent" },
    { term: "", kind: "org", reason: "frequent" },
    "not an object",
  ],
  corrections: [
    { from: "D-Brain", to: "gbrain" },
    { from: "G-Brain", to: "gbrain" },
    { from: "d-brain", to: "gbrain" },
    { from: "Erick", to: "Ricardo" },
    { from: "Rapplet", to: "Replit" },
    { from: "banana", to: "Supabase" },
    { from: "gbrain", to: "GBRAIN" },
    { from: "{inject}", to: "gbrain" },
  ],
  participants: [{ name: "Erick", entityId: "default:person:erick" }],
};

test("participants sent to the graph are real names, deduplicated, without separators", () => {
  assert.deepEqual(
    vocabularyParticipants(["You", "Ana, Souza", "Bruno", "bruno", "Participante", ""]),
    ["Ana Souza", "Bruno"],
  );
  assert.equal(participantsKey(["Bruno", "Ana"]), participantsKey(["ana", "Bruno", "You"]));
});

test("the engine answer is validated before anything is used", () => {
  const vocabulary = parseVocabularyResponse(ENGINE_ANSWER, ["Erick", "Gustavo"], 1234);
  // Participants are named in the prompt already; duplicates and markup are dropped.
  assert.deepEqual(vocabulary.terms, ["ValorBrain", "gbrain", "Resend", "Stripe"]);
  assert.deepEqual(vocabulary.corrections, [
    { from: "D-Brain", to: "gbrain" },
    { from: "G-Brain", to: "gbrain" },
    { from: "Rapplet", to: "Replit" },
  ]);
  assert.equal(vocabulary.fetchedAt, 1234);
  assert.equal(vocabulary.participantsKey, participantsKey(["Gustavo", "Erick"]));
});

test("a malformed answer yields an empty vocabulary, never an error", () => {
  assert.deepEqual(parseVocabularyResponse(null, []).terms, []);
  assert.deepEqual(parseVocabularyResponse({ terms: "x", corrections: {} }, []).corrections, []);
  assert.deepEqual(parseVocabularyResponse([1, 2], []).terms, []);
});

test("fetchMeetVocabulary asks for the call's participants with the connection token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await fetchMeetVocabulary(
    { ...SETTINGS, tenantId: "tenant-1" },
    ["Gustavo", "You", "Erick"],
    {
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, ENGINE_ANSWER);
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(
    url.origin + url.pathname,
    "https://valorbrain-api.valor.digital/api/v1/meet/vocabulary",
  );
  assert.equal(url.searchParams.get("participants"), "Gustavo,Erick");
  assert.equal(url.searchParams.get("limit"), "40");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer vbm_test");
  assert.equal(headers["X-Tenant-ID"], "tenant-1");
  assert.equal(calls[0].init.method, "GET");
  if (result.ok) assert.ok(result.vocabulary.terms.includes("gbrain"));
});

test("fetchMeetVocabulary reports an older engine (404) and bad tokens without throwing", async () => {
  const notFound = await fetchMeetVocabulary(SETTINGS, [], {
    fetchImpl: (async () => jsonResponse(404, { error: "not found" })) as unknown as typeof fetch,
  });
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.equal(notFound.kind, "server");

  const denied = await fetchMeetVocabulary(SETTINGS, [], {
    fetchImpl: (async () => jsonResponse(401, {})) as unknown as typeof fetch,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.kind, "auth");

  const unconfigured = await fetchMeetVocabulary({ ...SETTINGS, apiToken: "" }, [], {
    fetchImpl: (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch,
  });
  assert.equal(unconfigured.ok, false);
  if (!unconfigured.ok) assert.equal(unconfigured.kind, "config");
});

test("fetchMeetVocabulary gives up quickly when the engine is slow", async () => {
  const started = Date.now();
  const result = await fetchMeetVocabulary(SETTINGS, [], {
    timeoutMs: 50,
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "timeout");
  assert.ok(Date.now() - started < 2000);
});

test("recordMeetAliases sends only this meeting's accepted fixes", async () => {
  const bodies: unknown[] = [];
  const result = await recordMeetAliases(
    SETTINGS,
    [
      { from: "Rapplet", to: "Replit", count: 2 },
      { from: "D-Brain", to: "gbrain", count: 3, source: "graph" },
      { from: "Draga", to: "Braga", count: 0 },
      { from: "rapplet", to: "Replit", count: 1 },
      { from: "SuperBase", to: "Supabase", count: 1 },
    ],
    {
      fetchImpl: (async (url: string, init: RequestInit) => {
        assert.equal(url, "https://valorbrain-api.valor.digital/api/v1/meet/aliases");
        assert.equal(init.method, "POST");
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse(201, {
          recorded: [{ from: "Rapplet", to: "Replit" }],
          skipped: [{ from: "SuperBase", to: "Supabase", reason: "apelido já registrado" }],
        });
      }) as unknown as typeof fetch,
    },
  );
  assert.deepEqual(bodies, [
    {
      aliases: [
        { from: "Rapplet", to: "Replit" },
        { from: "SuperBase", to: "Supabase" },
      ],
    },
  ]);
  assert.deepEqual(result, { ok: true, recorded: 1, skipped: 1 });
});

test("recordMeetAliases makes no request when there is nothing to teach", async () => {
  const result = await recordMeetAliases(
    SETTINGS,
    [{ from: "D-Brain", to: "gbrain", count: 3, source: "graph" }],
    {
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    },
  );
  assert.deepEqual(result, { ok: true, recorded: 0, skipped: 0 });
});
