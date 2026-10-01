/**
 * End-to-end test of the service-worker meeting lifecycle with a mocked Chrome
 * runtime and mocked providers:
 *
 *   start → audio chunks → STT (hallucinations filtered) → stop →
 *   tail transcribed → final PT-BR summary → session saved → sent to ValorBrain
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

const localStore: AnyRecord = {
  settings: {
    "vb.baseUrl": "https://valorbrain-api.valor.digital",
    "vb.apiToken": "vbm_test_token",
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
const runtimeMessages: AnyRecord[] = [];
const badgeTexts: string[] = [];
const notifications: AnyRecord[] = [];
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

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

const sttResponses: AnyRecord[] = [];
/** What the model answers to the final spelling pass (no corrections by default). */
let correctionResponse: AnyRecord = { correcoes: [] };

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
  if (
    url === "https://api.z.ai/api/coding/paas/v4/chat/completions" &&
    /revisa a grafia/.test(chatSystemPrompt(init))
  ) {
    return jsonResponse(200, {
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(correctionResponse) } },
      ],
      usage: { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 },
    });
  }
  if (url === "https://api.z.ai/api/coding/paas/v4/chat/completions") {
    return jsonResponse(200, {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              summary: "A equipe decidiu lançar a versão 2 na sexta-feira.",
              summaryItems: [
                { text: "Lançamento na sexta", chunkId: "chunk_1", timestampLabel: "00:00" },
              ],
              topics: [{ name: "Lançamento da versão 2", status: "completed" }],
              currentTopic: "Lançamento da versão 2",
              decisions: [
                { text: "Lançar na sexta-feira", chunkId: "chunk_1", classification: "finalized" },
              ],
              actionItems: [
                { task: "Preparar o changelog", owner: "Bruno", deadline: "quinta-feira" },
              ],
              sentiment: "positive",
              keyInsights: [],
              contradictions: [],
              questionsRaised: ["Qual o preço do plano empresarial?"],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    });
  }
  if (url === "https://valorbrain-api.valor.digital/api/v1/memory/store") {
    return jsonResponse(200, { ok: true, docid: "#abc123", path: "meetings/reuniao.md" });
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
        runtimeMessages.push(message);
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
      setBadgeText: async ({ text }: { text: string }) => {
        badgeTexts.push(text);
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    notifications: {
      create: (_id: string, options: AnyRecord, cb?: () => void) => {
        notifications.push(options);
        cb?.();
      },
    },
    alarms: { onAlarm: ignored, create: () => {} },
    tabs: {
      onUpdated: ignored,
      onActivated: ignored,
      onRemoved: ignored,
      get: async () => ({}),
      query: async () => [],
      sendMessage: async () => {},
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

/** ~6 KB of fake WebM bytes, base64 encoded (the STT server is mocked). */
function fakeChunk(): string {
  return Buffer.alloc(6000, 7).toString("base64");
}

const TAB_ID = 7;
const MEET_URL = "https://meet.google.com/abc-defg-hij";

test("a recording is transcribed, its language detected, summarized in it, saved and delivered to ValorBrain", async () => {
  const start = await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "abc-defg-hij",
    meetingUrl: MEET_URL,
    streamId: "stream-from-popup",
    includeMicrophone: true,
  });
  assert.equal(start.success, true, JSON.stringify(start));
  assert.equal(start.micActive, true);
  assert.equal(badgeTexts.at(-1), "REC");

  const startCapture = runtimeMessages.find((m) => m.type === "OFFSCREEN_START_CAPTURE");
  assert.equal(startCapture?.streamId, "stream-from-popup");

  sttResponses.push(
    {
      text: "Bom dia, pessoal. A decisão é lançar a versão 2 na sexta-feira.",
      // OpenAI-style detection: a language name, not a code.
      language: "portuguese",
      duration: 6,
      segments: [
        { text: " Bom dia, pessoal.", no_speech_prob: 0.01, avg_logprob: -0.2 },
        {
          text: " A decisão é lançar a versão 2 na sexta-feira.",
          no_speech_prob: 0.01,
          avg_logprob: -0.2,
        },
      ],
    },
    // Silence hallucination: must never reach the transcript.
    {
      text: "Legendas pela comunidade Amara.org",
      duration: 8,
      segments: [
        { text: " Legendas pela comunidade Amara.org", no_speech_prob: 0.7, avg_logprob: -0.9 },
      ],
    },
    {
      text: "Combinado. Eu preparo o changelog até quinta-feira.",
      duration: 5,
      segments: [
        {
          text: " Combinado. Eu preparo o changelog até quinta-feira.",
          no_speech_prob: 0.02,
          avg_logprob: -0.25,
        },
      ],
    },
  );

  for (let i = 0; i < 3; i += 1) {
    const now = Date.now();
    const ack = await sendMessage({
      type: "OFFSCREEN_AUDIO_CHUNK",
      audioBase64: fakeChunk(),
      mimeType: "audio/webm;codecs=opus",
      startedAt: now - 6000,
      endedAt: now,
    });
    assert.equal(ack.success, true, JSON.stringify(ack));
  }

  const live = await waitFor(async () => {
    const snapshot = await sendMessage({ type: "GET_STATE" });
    return snapshot.stats?.chunksTranscribed + snapshot.stats?.chunksFiltered === 3
      ? snapshot
      : null;
  }, "3 chunks processed");
  assert.equal(live.transcript.length, 2);
  assert.equal(live.stats.chunksFiltered, 1);
  assert.ok(live.transcript.every((e: AnyRecord) => !/Amara/.test(e.text)));
  assert.equal(live.transcript[0].id, "chunk_1");

  const sttCall = fetchCalls.find((c) => c.url.endsWith("/audio/transcriptions"))!;
  const form = sttCall.init.body as FormData;
  // Nothing fixed in Settings: the first segment goes without a language (detection).
  assert.equal(form.get("language"), null);
  assert.equal(form.get("temperature"), "0");
  assert.equal(
    (sttCall.init.headers as AnyRecord).Authorization,
    undefined,
    "local Whisper gets no auth header",
  );

  const stop = await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  assert.equal(stop.success, true);

  const lastResult = await waitFor(
    () =>
      localStore.lastSessionResult?.vb?.status === "sent" ? localStore.lastSessionResult : null,
    "ValorBrain delivery",
  );
  assert.equal(lastResult.empty, false);
  assert.equal(lastResult.transcriptEntries, 2);
  assert.equal(lastResult.title, "Lançamento da versão 2");
  assert.equal(lastResult.vb.docRef, "meetings/reuniao.md");

  // Final summary pass is written in the detected language, with GLM thinking disabled.
  const chatCall = fetchCalls.find(
    (c) =>
      c.url.endsWith("/chat/completions") && /motor de inteligência/.test(chatSystemPrompt(c.init)),
  )!;
  const chatBody = JSON.parse(String(chatCall.init.body));
  assert.deepEqual(chatBody.thinking, { type: "disabled" });
  assert.match(chatBody.messages[0].content, /Escreva sempre em português/);
  assert.match(chatBody.messages[0].content, /passagem final/);
  assert.match(chatBody.messages[1].content, /changelog/);
  // The spelling pass ran before it.
  const correctionIndex = fetchCalls.findIndex(
    (c) => c.url.endsWith("/chat/completions") && /revisa a grafia/.test(chatSystemPrompt(c.init)),
  );
  assert.ok(correctionIndex >= 0 && correctionIndex < fetchCalls.indexOf(chatCall));

  // Saved locally with the summary and the delivery status.
  const index = localStore.savedSessionIndex as AnyRecord[];
  assert.equal(index.length, 1);
  const saved = localStore[`savedSession:${index[0].id}`];
  assert.equal(saved.summary, "A equipe decidiu lançar a versão 2 na sexta-feira.");
  assert.equal(saved.decisions[0].text, "Lançar na sexta-feira");
  assert.equal(saved.transcript.length, 2);
  assert.equal(saved.vb.status, "sent");
  assert.equal(saved.isActive, false);

  // Delivered to the tenant with the OAuth token and PT-BR sections.
  const storeCall = fetchCalls.find((c) => c.url.endsWith("/api/v1/memory/store"))!;
  assert.equal((storeCall.init.headers as AnyRecord).Authorization, "Bearer vbm_test_token");
  const payload = JSON.parse(String(storeCall.init.body));
  assert.equal(payload.collection, "meetings");
  assert.match(payload.title, /^Reunião: Lançamento da versão 2 \(/);
  assert.match(payload.content, /## Resumo\nA equipe decidiu lançar/);
  assert.match(payload.content, /## Próximos passos\n- \[ \] Preparar o changelog — Bruno/);
  assert.match(payload.content, /## Pontos em aberto\n- Qual o preço do plano empresarial\?/);
  assert.match(payload.content, /## Transcrição\n\[00:00\] Participante: Bom dia, pessoal\./);

  // UI side effects: session-ended event, badge cleared, offscreen closed, notification.
  assert.ok(runtimeMessages.some((m) => m.type === "SESSION_ENDED" && m.saved === true));
  assert.equal(badgeTexts.at(-1), "");
  assert.equal(offscreenOpen, false);
  assert.ok(notifications.some((n) => n.title === "Reunião salva no ValorBrain"));

  const after = await sendMessage({ type: "GET_STATE" });
  assert.equal(after.audioActive, false);
  assert.equal(after.transcript.length, 0, "live state is reset after saving");
});

test("a recording where nothing was said saves nothing and says so", async () => {
  const before = (localStore.savedSessionIndex as AnyRecord[]).length;
  const start = await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "abc-defg-hij",
    meetingUrl: MEET_URL,
    streamId: "stream-2",
  });
  assert.equal(start.success, true);

  sttResponses.push({ text: "Obrigado por assistir!", segments: [] });
  await sendMessage({
    type: "OFFSCREEN_AUDIO_CHUNK",
    audioBase64: fakeChunk(),
    mimeType: "audio/webm",
    startedAt: Date.now() - 3000,
  });

  await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  const lastResult = await waitFor(
    () => (localStore.lastSessionResult?.empty === true ? localStore.lastSessionResult : null),
    "empty session result",
  );
  assert.equal(lastResult.sessionId, null);
  assert.equal((localStore.savedSessionIndex as AnyRecord[]).length, before);
  assert.ok(notifications.some((n) => n.title === "Nada foi transcrito nesta gravação"));
});

test("a transcription outage is reported to the user in PT-BR", async () => {
  await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "abc-defg-hij",
    meetingUrl: MEET_URL,
    streamId: "stream-3",
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/audio/transcriptions")) {
      return jsonResponse(401, { error: { message: "invalid bearer" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    await sendMessage({
      type: "OFFSCREEN_AUDIO_CHUNK",
      audioBase64: fakeChunk(),
      mimeType: "audio/webm",
      startedAt: Date.now() - 3000,
    });
    const snapshot = await waitFor(async () => {
      const s = await sendMessage({ type: "GET_STATE" });
      return s.notice?.scope === "transcription" ? s : null;
    }, "transcription notice");
    assert.equal(snapshot.notice.severity, "error");
    assert.match(snapshot.notice.message, /recusou a chave de API \(HTTP 401\)/);
    assert.equal(snapshot.stats.chunksFailed, 1);
  } finally {
    globalThis.fetch = realFetch;
    await sendMessage({ type: "MANUAL_STOP_AUDIO" });
    await waitFor(
      async () => ((await sendMessage({ type: "GET_STATE" })).audioActive === false ? true : null),
      "stop",
    );
  }
});

test("the microphone is the user, echoes are dropped and misheard terms are fixed before saving", async () => {
  localStore.settings = {
    ...localStore.settings,
    selfName: "Gustavo",
    transcriptionVocabulary: "gbrain, Resend",
  };
  const savedBefore = (localStore.savedSessionIndex as AnyRecord[]).length;
  fetchCalls.length = 0;

  const start = await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "abc-defg-hij",
    meetingUrl: MEET_URL,
    streamId: "stream-4",
    includeMicrophone: true,
  });
  assert.equal(start.success, true, JSON.stringify(start));

  // One-to-one call: Meet shows the user and Ricardo.
  const sender = { tab: { id: TAB_ID, url: MEET_URL } };
  await sendMessage({ type: "PARTICIPANTS_UPDATED", participants: ["Gustavo", "Ricardo"] }, sender);

  const t0 = Date.now() - 20_000;
  const say = (text: string) => ({
    text,
    duration: 5,
    segments: [{ text: ` ${text}`, no_speech_prob: 0.02, avg_logprob: -0.3 }],
  });
  sttResponses.push(
    say("Na Resend eles usam o D-Brain e o Rapplet para os agentes."),
    say("Olha, o D-Brain já resolve uma parte disso pra gente."),
    // The same sentence picked up by the microphone from the speakers.
    say("Na Resend eles usam o D-Brain e o Rapplet para os agentes"),
  );
  const chunk = (source: string, startOffset: number) =>
    sendMessage({
      type: "OFFSCREEN_AUDIO_CHUNK",
      audioBase64: fakeChunk(),
      mimeType: "audio/webm;codecs=opus",
      source,
      startedAt: t0 + startOffset,
      endedAt: t0 + startOffset + 5000,
    });
  // The tab segment ends (and arrives) first, but the user started speaking earlier.
  await chunk("tab", 3000);
  await chunk("mic", 0);
  await chunk("mic", 3500);

  const live = await waitFor(async () => {
    const s = await sendMessage({ type: "GET_STATE" });
    return s.stats?.chunksTranscribed + s.stats?.chunksFiltered === 3 ? s : null;
  }, "3 chunks processed");
  assert.deepEqual(
    live.transcript.map((e: AnyRecord) => [e.source, e.speaker]),
    [
      ["mic", "Gustavo"],
      ["tab", "Ricardo"],
    ],
    "in time order, the echo dropped",
  );

  const sttPrompts = fetchCalls
    .filter((c) => c.url.endsWith("/audio/transcriptions"))
    .map((c) => String((c.init.body as FormData).get("prompt")));
  assert.match(sttPrompts[0], /^gbrain, Resend\. /);
  assert.match(sttPrompts[0], / Gustavo, Ricardo\./);

  correctionResponse = {
    correcoes: [
      { de: "D-Brain", para: "gbrain" },
      { de: "Rapplet", para: "Replit" },
      { de: "Ricardo", para: "Roberto" }, // one person for another: rejected
    ],
  };
  await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  const index = await waitFor(
    () =>
      (localStore.savedSessionIndex as AnyRecord[]).length === savedBefore + 1
        ? (localStore.savedSessionIndex as AnyRecord[])
        : null,
    "session saved",
  );
  const saved = localStore[`savedSession:${index[0].id}`];
  assert.equal(saved.transcript[0].text, "Olha, o gbrain já resolve uma parte disso pra gente.");
  assert.equal(
    saved.transcript[1].text,
    "Na Resend eles usam o gbrain e o Replit para os agentes.",
  );
  assert.equal(saved.transcript[1].speaker, "Ricardo");
  assert.deepEqual(saved.termCorrections, [
    { from: "D-Brain", to: "gbrain", count: 2 },
    { from: "Rapplet", to: "Replit", count: 1 },
  ]);

  // The final summary knows who recorded and reads the corrected text.
  const summaryCall = fetchCalls.find(
    (c) =>
      c.url.endsWith("/chat/completions") && /motor de inteligência/.test(chatSystemPrompt(c.init)),
  )!;
  const summaryUser = JSON.parse(String(summaryCall.init.body)).messages[1].content;
  assert.match(summaryUser, /Quem gravou a reunião: Gustavo\./);
  assert.match(summaryUser, /Gustavo: Olha, o gbrain já resolve/);

  const store = await waitFor(
    () => fetchCalls.find((c) => c.url.endsWith("/api/v1/memory/store")),
    "ValorBrain delivery",
  );
  const payload = JSON.parse(String(store.init.body));
  assert.match(payload.content, /- Grafia revisada na transcrição: gbrain \(2\), Replit\n/);
  assert.match(payload.content, /\] Gustavo: Olha, o gbrain/);
  correctionResponse = { correcoes: [] };
});

test("muting the microphone in Meet reaches the recorder", async () => {
  runtimeMessages.length = 0;
  await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "abc-defg-hij",
    meetingUrl: MEET_URL,
    streamId: "stream-5",
  });
  const sender = { tab: { id: TAB_ID, url: MEET_URL } };
  const muted = await sendMessage({ type: "MEET_MIC_STATE", muted: true }, sender);
  assert.equal(muted.muted, true);
  assert.ok(runtimeMessages.some((m) => m.type === "OFFSCREEN_SET_MIC_MUTED" && m.muted === true));
  const ignored = await sendMessage(
    { type: "MEET_MIC_STATE", muted: false },
    {
      tab: { id: 99, url: "https://meet.google.com/xyz-abcd-efg" },
    },
  );
  assert.equal(ignored.ignored, true, "another tab cannot unmute the recording");
  await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  await waitFor(
    async () => ((await sendMessage({ type: "GET_STATE" })).audioActive === false ? true : null),
    "stop",
  );
});
