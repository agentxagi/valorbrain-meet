/**
 * Service-worker flow of Meet 2.2 with a mocked Chrome runtime and mocked
 * providers:
 *
 *   start → recording notice in the call chat (opt-in, once per meeting)
 *         → company vocabulary from the ValorBrain graph (Whisper prompt)
 *         → learned corrections applied to each line ("D-Brain" → gbrain)
 *   stop  → final review adds this meeting's fixes → session saved and sent
 *         → the review's fixes (not the learned ones) taught back as aliases
 *
 * Node's test runner isolates each file in its own process, so this file owns
 * a single fresh import of the background module.
 */
import test from "node:test";
import assert from "node:assert/strict";

type AnyRecord = Record<string, any>;
type MessageListener = (
  message: AnyRecord,
  sender: AnyRecord,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

const VB = "https://valorbrain-api.valor.digital";
const localStore: AnyRecord = {
  settings: {
    "vb.baseUrl": VB,
    "vb.apiToken": "vbm_test_token",
    selfName: "Gustavo",
    recordingChatNotice: true,
  },
  "provider.transcription": {
    profile: "whisper-local",
    baseUrl: "http://127.0.0.1:8394/v1",
    apiKey: "",
    model: "whisper-local",
  },
  "provider.summary": {
    profile: "zai-coding",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKey: "zai-test-key",
    model: "glm-5.3-flash",
  },
};
const sessionStore: AnyRecord = {};

let messageListener: MessageListener | undefined;
let offscreenOpen = false;
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
const tabMessages: Array<{ tabId: number; message: AnyRecord }> = [];
let chatAvailable = true;
const sttResponses: AnyRecord[] = [];
let correctionResponse: AnyRecord = { correcoes: [] };

/** The vocabulary the engine answers (shape of GET /api/v1/meet/vocabulary). */
const VOCABULARY = {
  terms: [
    { term: "Ricardo", kind: "person", reason: "participant" },
    { term: "gbrain", kind: "tool", reason: "meeting" },
    { term: "Supabase", kind: "service", reason: "related" },
    { term: "Valor Digital", kind: "org", reason: "frequent" },
  ],
  corrections: [{ from: "D-Brain", to: "gbrain" }],
  participants: [{ name: "Ricardo", entityId: "default:person:ricardo" }],
};

function toKeyList(keys: string | string[] | AnyRecord | null | undefined, store: AnyRecord) {
  if (Array.isArray(keys)) return keys;
  if (typeof keys === "string") return [keys];
  return Object.keys(keys ?? store);
}

function createStorageArea(store: AnyRecord) {
  return {
    async get(keys?: string | string[] | AnyRecord | null) {
      const out: AnyRecord = {};
      for (const key of toKeyList(keys, store)) {
        if (key in store) out[key] = structuredClone(store[key]);
      }
      return out;
    },
    async set(values: AnyRecord) {
      for (const [key, value] of Object.entries(values)) store[key] = structuredClone(value);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async getBytesInUse() {
      return JSON.stringify(store).length;
    },
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chatSystemPrompt(init: RequestInit): string {
  return String(JSON.parse(String(init.body)).messages?.[0]?.content ?? "");
}

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url === "http://127.0.0.1:8394/v1/audio/transcriptions") {
    return jsonResponse(200, sttResponses.shift() ?? { text: "", segments: [] });
  }
  if (url.startsWith(`${VB}/api/v1/meet/vocabulary`)) return jsonResponse(200, VOCABULARY);
  if (url === `${VB}/api/v1/meet/aliases`) {
    const aliases = JSON.parse(String(init.body)).aliases;
    return jsonResponse(201, { recorded: aliases, skipped: [] });
  }
  if (url === `${VB}/api/v1/memory/store`) {
    return jsonResponse(200, { ok: true, docid: "#abc123", path: "meetings/reuniao.md" });
  }
  if (url.endsWith("/chat/completions") && /revisa a grafia/.test(chatSystemPrompt(init))) {
    return jsonResponse(200, {
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(correctionResponse) } },
      ],
      usage: { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 },
    });
  }
  if (url.endsWith("/chat/completions")) {
    return jsonResponse(200, {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              summary: "A Resend usa o gbrain e o Replit nos agentes.",
              summaryItems: [],
              topics: [{ name: "Parceria com a Resend", status: "active" }],
              currentTopic: "Parceria com a Resend",
              decisions: [],
              actionItems: [],
              sentiment: "positive",
              keyInsights: [],
              contradictions: [],
              questionsRaised: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    });
  }
  return jsonResponse(404, { error: "unexpected url " + url });
}) as typeof fetch;

function installChromeMock() {
  if (typeof (globalThis as AnyRecord).addEventListener !== "function") {
    (globalThis as AnyRecord).addEventListener = () => {};
    (globalThis as AnyRecord).removeEventListener = () => {};
  }
  (globalThis as AnyRecord).self = globalThis;
  const ignored = { addListener: () => {} };

  (globalThis as AnyRecord).chrome = {
    runtime: {
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://vbmeet/${path}`,
      getContexts: async () => (offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      getPlatformInfo: (cb: () => void) => cb?.(),
      sendMessage: async (message: AnyRecord) => {
        switch (message.type) {
          case "OFFSCREEN_PING":
            return { success: true };
          case "OFFSCREEN_START_CAPTURE":
            return { success: true, microphoneActive: true };
          case "OFFSCREEN_STOP_CAPTURE":
            return { success: true, drainComplete: true };
          default:
            return undefined;
        }
      },
      onMessage: {
        addListener: (cb: MessageListener) => {
          messageListener = cb;
        },
      },
      onInstalled: ignored,
      onStartup: ignored,
      onSuspend: ignored,
    },
    offscreen: {
      createDocument: async () => {
        offscreenOpen = true;
      },
      closeDocument: async () => {
        offscreenOpen = false;
      },
    },
    tabCapture: {
      getMediaStreamId: (_opts: AnyRecord, cb: (id: string) => void) => cb("stream-from-sw"),
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    notifications: { create: (_id: string, _options: AnyRecord, cb?: () => void) => cb?.() },
    alarms: { onAlarm: ignored, create: () => {} },
    tabs: {
      onUpdated: ignored,
      onActivated: ignored,
      onRemoved: ignored,
      get: async () => ({}),
      query: async () => [],
      sendMessage: async (tabId: number, message: AnyRecord) => {
        tabMessages.push({ tabId, message });
        if (message.type === "SEND_CHAT_MESSAGE") return { success: chatAvailable };
        return undefined;
      },
      create: async () => ({}),
    },
    commands: { onCommand: ignored },
    contextMenus: {
      onClicked: ignored,
      removeAll: (callback?: () => void) => callback?.(),
      create: () => {},
    },
    sidePanel: { open: async () => {} },
    storage: {
      local: createStorageArea(localStore),
      session: createStorageArea(sessionStore),
      onChanged: ignored,
    },
  };
}

installChromeMock();
await import("./background.ts");

function sendMessage(message: AnyRecord, sender: AnyRecord = {}): Promise<AnyRecord> {
  return new Promise((resolve) => {
    assert.ok(messageListener, "background must register a runtime.onMessage listener");
    const kept = messageListener!(message, sender, (response) =>
      resolve((response ?? {}) as AnyRecord),
    );
    if (kept !== true) resolve({});
  });
}

async function waitFor<T>(probe: () => T | Promise<T>, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeChunk(): string {
  return Buffer.alloc(6000, 7).toString("base64");
}

const say = (text: string) => ({
  text,
  duration: 5,
  segments: [{ text: ` ${text}`, no_speech_prob: 0.02, avg_logprob: -0.3 }],
});

const TAB_ID = 11;
const MEET_URL = "https://meet.google.com/cfy-astc-cey";

async function record(
  meetingUrl: string,
  meetingId: string,
  lines: string[],
  { waitVocabulary = true } = {},
) {
  const start = await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId,
    meetingUrl,
    streamId: `stream-${Date.now()}`,
    includeMicrophone: true,
  });
  assert.equal(start.success, true, JSON.stringify(start));
  // In a real call the first segment arrives ~20 s after the start, long after
  // the vocabulary (8 s timeout); here the chunks are immediate, so wait for it.
  if (waitVocabulary) {
    await waitFor(async () => {
      const s = await sendMessage({ type: "GET_STATE" });
      return s.timeline?.some((e: AnyRecord) => /Vocabulário do ValorBrain/.test(e.event));
    }, "graph vocabulary loaded");
  }
  sttResponses.push(...lines.map(say));
  const t0 = Date.now() - 20_000;
  for (let i = 0; i < lines.length; i += 1) {
    await sendMessage({
      type: "OFFSCREEN_AUDIO_CHUNK",
      audioBase64: fakeChunk(),
      mimeType: "audio/webm;codecs=opus",
      source: "tab",
      startedAt: t0 + i * 6000,
      endedAt: t0 + i * 6000 + 5000,
    });
  }
  return waitFor(async () => {
    const s = await sendMessage({ type: "GET_STATE" });
    return s.stats?.chunksTranscribed + s.stats?.chunksFiltered === lines.length ? s : null;
  }, `${lines.length} chunks processed`);
}

async function stopAndWaitSaved(savedBefore: number) {
  await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  const index = await waitFor(
    () =>
      ((localStore.savedSessionIndex as AnyRecord[]) ?? []).length === savedBefore + 1
        ? (localStore.savedSessionIndex as AnyRecord[])
        : null,
    "session saved",
  );
  return localStore[`savedSession:${index[0].id}`];
}

test("the graph vocabulary, the chat notice and the learned fixes work together", async () => {
  const live = await record(MEET_URL, "cfy-astc-cey", [
    "Na Resend eles usam o D-Brain e o Rapplet para os agentes.",
  ]);

  // Chat notice: posted once in the recorded tab, with the default text.
  const notices = tabMessages.filter((m) => m.message.type === "SEND_CHAT_MESSAGE");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tabId, TAB_ID);
  assert.match(notices[0].message.text, /gravada e transcrita pelo ValorBrain Meet/);

  // Vocabulary: asked with the recording user's name, the connection token.
  const vocabularyCall = fetchCalls.find((c) => c.url.startsWith(`${VB}/api/v1/meet/vocabulary`))!;
  assert.ok(vocabularyCall, "the graph vocabulary was requested");
  assert.equal(new URL(vocabularyCall.url).searchParams.get("participants"), "Gustavo");
  assert.equal((vocabularyCall.init.headers as AnyRecord).Authorization, "Bearer vbm_test_token");

  // The learned correction fixed the line as it arrived.
  assert.equal(
    live.transcript[0].text,
    "Na Resend eles usam o gbrain e o Rapplet para os agentes.",
  );
  assert.deepEqual(live.termCorrections, [
    { from: "D-Brain", to: "gbrain", count: 1, source: "graph" },
  ]);
  assert.ok(
    live.timeline.some((e: AnyRecord) => /Vocabulário do ValorBrain: 3 termos/.test(e.event)),
  );
  assert.ok(live.timeline.some((e: AnyRecord) => /Aviso de gravação publicado/.test(e.event)));

  // Graph terms entered the Whisper prompt (after the built-ins); the
  // participant the graph returned is named in the prompt already.
  const sttCall = fetchCalls.find((c) => c.url.endsWith("/audio/transcriptions"))!;
  const prompt = String((sttCall.init.body as FormData).get("prompt"));
  assert.match(prompt, /^Termos: ValorBrain, ValorBrain Meet, gbrain, Supabase, Valor Digital\./);

  correctionResponse = { correcoes: [{ de: "Rapplet", para: "Replit" }] };
  const saved = await stopAndWaitSaved(0);
  correctionResponse = { correcoes: [] };

  assert.equal(
    saved.transcript[0].text,
    "Na Resend eles usam o gbrain e o Replit para os agentes.",
  );
  assert.deepEqual(saved.termCorrections, [
    { from: "D-Brain", to: "gbrain", count: 1, source: "graph" },
    { from: "Rapplet", to: "Replit", count: 1 },
  ]);
  assert.equal(saved.graphVocabulary, undefined, "the vocabulary is not saved with the meeting");

  // The review's glossary knew the graph terms too.
  const reviewCall = fetchCalls.find(
    (c) => c.url.endsWith("/chat/completions") && /revisa a grafia/.test(chatSystemPrompt(c.init)),
  )!;
  assert.match(JSON.parse(String(reviewCall.init.body)).messages[1].content, /Supabase/);

  // After the delivery: only this meeting's fix is taught back.
  const aliasesCall = await waitFor(
    () => fetchCalls.find((c) => c.url === `${VB}/api/v1/meet/aliases`),
    "aliases taught",
  );
  assert.deepEqual(JSON.parse(String(aliasesCall.init.body)), {
    aliases: [{ from: "Rapplet", to: "Replit" }],
  });
  const store = fetchCalls.find((c) => c.url === `${VB}/api/v1/memory/store`)!;
  assert.match(
    JSON.parse(String(store.init.body)).content,
    /Termos corrigidos na transcrição: D-Brain → gbrain, Rapplet → Replit/,
  );
});

test("a second recording in the same call does not post the notice again", async () => {
  tabMessages.length = 0;
  const savedBefore = (localStore.savedSessionIndex as AnyRecord[]).length;
  const live = await record(MEET_URL, "cfy-astc-cey", ["Continuando a pauta do Supabase."]);
  assert.equal(tabMessages.filter((m) => m.message.type === "SEND_CHAT_MESSAGE").length, 0);
  assert.ok(
    live.timeline.some((e: AnyRecord) => /já publicado no chat desta reunião/.test(e.event)),
  );
  await stopAndWaitSaved(savedBefore);
});

test("with the options off: no notice, no graph request, nothing taught", async () => {
  localStore.settings = {
    ...localStore.settings,
    recordingChatNotice: false,
    graphVocabulary: false,
    learnCorrections: false,
  };
  tabMessages.length = 0;
  fetchCalls.length = 0;
  const savedBefore = (localStore.savedSessionIndex as AnyRecord[]).length;
  const live = await record(
    "https://meet.google.com/abc-defg-hij",
    "abc-defg-hij",
    ["O D-Brain e o Rapplet de novo."],
    { waitVocabulary: false },
  );
  assert.equal(
    live.transcript[0].text,
    "O D-Brain e o Rapplet de novo.",
    "no learned fixes applied",
  );
  correctionResponse = { correcoes: [{ de: "Rapplet", para: "Replit" }] };
  await stopAndWaitSaved(savedBefore);
  correctionResponse = { correcoes: [] };
  await waitFor(() => fetchCalls.find((c) => c.url === `${VB}/api/v1/memory/store`), "delivery");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tabMessages.filter((m) => m.message.type === "SEND_CHAT_MESSAGE").length, 0);
  assert.equal(fetchCalls.filter((c) => c.url.includes("/api/v1/meet/")).length, 0);
});

test("Zoom: the call tab records, its participants count and the notice retries without a chat", async () => {
  localStore.settings = {
    ...localStore.settings,
    recordingChatNotice: true,
    graphVocabulary: true,
    learnCorrections: true,
  };
  chatAvailable = false;
  tabMessages.length = 0;
  const zoomUrl = "https://app.zoom.us/wc/85012345678/join";
  const start = await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "zoom-85012345678",
    meetingUrl: zoomUrl,
    streamId: "stream-zoom",
  });
  assert.equal(start.success, true, JSON.stringify(start));

  // Participants from the Zoom tab count (same meeting number).
  const sender = { tab: { id: TAB_ID, url: zoomUrl } };
  const participants = await sendMessage(
    { type: "PARTICIPANTS_UPDATED", participants: ["Gustavo", "Ana Souza"] },
    sender,
  );
  assert.equal(participants.success, true);
  assert.notEqual(participants.ignored, true);

  // The first try fails (no chat yet); the retries keep going in the background.
  await waitFor(
    () => tabMessages.some((m) => m.message.type === "SEND_CHAT_MESSAGE"),
    "first notice attempt",
  );
  await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  await waitFor(
    async () => ((await sendMessage({ type: "GET_STATE" })).audioActive === false ? true : null),
    "stop",
  );
  chatAvailable = true;
});
