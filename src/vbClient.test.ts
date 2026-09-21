import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAutoSend,
  buildValorBrainContent,
  buildValorBrainPayload,
  buildValorBrainTitle,
  extractDocRef,
  formatMeetingTimestamp,
  normalizeVbSettings,
  sendToValorBrain,
  testValorBrainConnection,
  DEFAULT_VB_SETTINGS,
  VB_STORE_PATH,
  type VbSettings,
} from "./vbClient.ts";
import { State } from "./types.ts";

function makeSession(overrides: Partial<State> = {}): State {
  return {
    isActive: false,
    meetingId: "abc-defg-hij",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    startTime: Date.UTC(2026, 0, 15, 14, 0, 0),
    savedAt: Date.UTC(2026, 0, 15, 15, 0, 0),
    summary: "Discutimos o roadmap do Q1.",
    topics: [],
    decisions: [{ text: "Adotar REST", by: "Gus" }],
    actionItems: [{ task: "Publicar o PRD", owner: "Ana", deadline: "2026-02-01" }],
    currentTopic: "",
    sentiment: "positive",
    keyInsights: [],
    unresolvedDiscussions: [],
    contradictions: [],
    questionsRaised: [],
    participants: ["Gus", "Ana"],
    initialParticipants: ["Gus"],
    lateJoiners: [],
    timeline: [],
    transcript: [
      { speaker: "Gus", text: "Vamos usar REST.", timestamp: 65, timestampLabel: "01:05" },
    ],
    summaryItems: [],
    audioActive: false,
    ...overrides,
  };
}

function configuredSettings(overrides: Partial<VbSettings> = {}): VbSettings {
  return {
    baseUrl: "https://memory.valor.digital",
    apiToken: "test-token",
    tenantId: "test-tenant",
    autoSend: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Settings normalization
// ---------------------------------------------------------------------------

test("normalizeVbSettings falls back to defaults for missing values", () => {
  const settings = normalizeVbSettings(undefined);
  assert.deepEqual(settings, DEFAULT_VB_SETTINGS);
  assert.equal(settings.baseUrl, "", "baseUrl default must be empty");
});

test("normalizeVbSettings trims strings, strips trailing slash, and reads autoSend", () => {
  const settings = normalizeVbSettings({
    "vb.baseUrl": "  https://memory.valor.digital/// ",
    "vb.apiToken": " tok ",
    "vb.tenantId": " 111e4567-e89b ",
    "vb.autoSend": true,
  });
  assert.equal(settings.baseUrl, "https://memory.valor.digital");
  assert.equal(settings.apiToken, "tok");
  assert.equal(settings.tenantId, "111e4567-e89b");
  assert.equal(settings.autoSend, true);
});

test("normalizeVbSettings treats non-boolean autoSend as on (intent default) and ignores non-strings", () => {
  const settings = normalizeVbSettings({
    "vb.baseUrl": 42,
    "vb.autoSend": "yes",
  });
  assert.equal(settings.baseUrl, "");
  assert.equal(settings.autoSend, true);
});

test("resolveAutoSend is on by default once configured", () => {
  assert.equal(resolveAutoSend(configuredSettings({ autoSend: true })), true);
});

test("resolveAutoSend honors an explicit opt-out even when configured", () => {
  assert.equal(resolveAutoSend(configuredSettings({ autoSend: false })), false);
});

test("resolveAutoSend is off when the connection is not configured", () => {
  assert.equal(
    resolveAutoSend({
      baseUrl: "",
      apiToken: "",
      tenantId: "",
      autoSend: true,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

test("formatMeetingTimestamp renders YYYY-MM-DD HH:mm in local time", () => {
  const ms = Date.UTC(2026, 0, 15, 14, 30, 0);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  assert.equal(formatMeetingTimestamp(ms), expected);
  assert.match(formatMeetingTimestamp(ms), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("buildValorBrainTitle follows 'Reunião: <title> (YYYY-MM-DD HH:mm)'", () => {
  const title = buildValorBrainTitle(makeSession());
  const expectedWhen = formatMeetingTimestamp(Date.UTC(2026, 0, 15, 15, 0, 0));
  assert.equal(title, `Reunião: abc-defg-hij (${expectedWhen})`);
});

test("buildValorBrainPayload matches the PRD contract", () => {
  const payload = buildValorBrainPayload(makeSession());
  assert.equal(payload.type, "observation");
  assert.equal(payload.collection, "meetings");
  assert.deepEqual(payload.tags, ["reuniao", "meet", "valorbrain-meet"]);
  assert.equal(payload.confidence, 0.85);
  assert.match(payload.title, /^Reunião: /);
});

test("buildValorBrainContent concatenates the existing summary under ## Resumo", () => {
  const content = buildValorBrainContent(makeSession());
  assert.ok(content.startsWith("## Resumo\nDiscutimos o roadmap do Q1.\n\n"));
});

test("buildValorBrainContent renders decisions, action items, and transcript", () => {
  const content = buildValorBrainContent(makeSession());
  assert.ok(content.includes("## Decisões\n- Adotar REST — Gus\n"));
  assert.ok(content.includes("## Action Items\n- [ ] Publicar o PRD — Ana (prazo: 2026-02-01)\n"));
  assert.ok(content.includes("## Transcript\n[01:05] Gus: Vamos usar REST."));
});

test("buildValorBrainContent fills placeholders for empty sections", () => {
  const content = buildValorBrainContent(
    makeSession({ summary: "  ", decisions: [], actionItems: [], transcript: [] }),
  );
  assert.ok(content.includes("## Resumo\n_(sem resumo)_"));
  assert.ok(content.includes("## Decisões\n_(nenhuma)_"));
  assert.ok(content.includes("## Action Items\n_(nenhum)_"));
  assert.ok(content.includes("## Transcript\n_(sem transcrição)_"));
});

test("buildValorBrainContent falls back to computed labels when timestampLabel is absent", () => {
  const content = buildValorBrainContent(
    makeSession({ transcript: [{ speaker: "Ana", text: "Oi", timestamp: 3725 }] }),
  );
  assert.ok(content.includes("[1:02:05] Ana: Oi"));
});

// ---------------------------------------------------------------------------
// Transport: headers, docRef, retry/timeout, error handling
// ---------------------------------------------------------------------------

test("sendToValorBrain posts the payload with auth, tenant, and JSON headers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return jsonResponse(200, { path: "tenant/meetings/doc-1" });
  };

  const result = await sendToValorBrain(makeSession(), configuredSettings(), { fetchImpl });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://memory.valor.digital" + VB_STORE_PATH));
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-token");
  assert.equal(headers.get("X-Tenant-ID"), "test-tenant");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.type, "observation");
  assert.equal(body.collection, "meetings");

  assert.deepEqual(result, { ok: true, docRef: "tenant/meetings/doc-1" });
});

test("sendToValorBrain prefers path over docid for the returned doc reference", () => {
  assert.equal(extractDocRef({ path: "p1", docid: "d1" }), "p1");
  assert.equal(extractDocRef({ docid: "d1" }), "d1");
  assert.equal(extractDocRef({ docid: 7 }), "7");
  assert.equal(extractDocRef({ nothing: true }), null);
  assert.equal(extractDocRef(null), null);
});

test("sendToValorBrain returns a config failure without calling fetch when unconfigured", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return jsonResponse(200);
  };

  const result = await sendToValorBrain(makeSession(), DEFAULT_VB_SETTINGS, { fetchImpl });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "config");
});

test("sendToValorBrain maps 401/403 to an auth failure without retrying", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(status);
    };

    const result = await sendToValorBrain(makeSession(), configuredSettings(), { fetchImpl });

    assert.equal(calls, 1, `HTTP ${status} must not be retried`);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "auth");
    if (!result.ok) {
      assert.match(result.error, /token|tenant/i);
    }
  }
});

test("sendToValorBrain retries once on 429 and then succeeds", async () => {
  const statuses = [429, 200];
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url));
    return jsonResponse(statuses.shift() ?? 500, { docid: "doc-after-retry" });
  };

  const result = await sendToValorBrain(makeSession(), configuredSettings(), {
    fetchImpl,
    backoffMs: 1,
  });

  assert.equal(urls.length, 2, "429 must be retried exactly once");
  assert.deepEqual(result, { ok: true, docRef: "doc-after-retry" });
});

test("sendToValorBrain gives up with a rateLimit failure after a second 429", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(429);
  };

  const result = await sendToValorBrain(makeSession(), configuredSettings(), {
    fetchImpl,
    backoffMs: 1,
  });

  assert.equal(calls, 2, "no second retry after the single 429 backoff");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "rateLimit");
  assert.equal(result.retryable, true);
});

test("sendToValorBrain reports a timeout when the request exceeds timeoutMs", async () => {
  const fetchImpl: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });

  const result = await sendToValorBrain(makeSession(), configuredSettings(), {
    fetchImpl,
    timeoutMs: 20,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "timeout");
});

test("sendToValorBrain reports network failures for unreachable hosts", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const result = await sendToValorBrain(makeSession(), configuredSettings(), { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "network");
});

test("sendToValorBrain classifies other HTTP errors as server failures", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse(500);

  const result = await sendToValorBrain(makeSession(), configuredSettings(), { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "server");
  assert.equal(result.retryable, true);
  assert.match(result.ok ? "" : result.error, /500/);
});

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

test("testValorBrainConnection hits /health with the auth headers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return jsonResponse(200, { status: "ok" });
  };

  const result = await testValorBrainConnection(configuredSettings(), { fetchImpl });

  assert.equal(result.ok, true);
  assert.match(result.message, /Connected/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://memory.valor.digital/health"));
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-token");
  assert.equal(headers.get("X-Tenant-ID"), "test-tenant");
});

test("testValorBrainConnection reports the failure reason", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse(403);

  const result = await testValorBrainConnection(configuredSettings(), { fetchImpl });

  assert.equal(result.ok, false);
  assert.match(result.message, /403/);
});

test("testValorBrainConnection refuses to run with an incomplete config", async () => {
  const result = await testValorBrainConnection({ ...DEFAULT_VB_SETTINGS });

  assert.equal(result.ok, false);
  assert.match(result.message, /Base URL/i);
});
