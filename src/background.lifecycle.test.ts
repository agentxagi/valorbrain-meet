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

const DEFAULT_SUMMARY: AnyRecord = {
  summary: "A equipe decidiu lançar a versão 2 na sexta-feira.",
  summaryItems: [{ text: "Lançamento na sexta", chunkId: "chunk_1", timestampLabel: "00:00" }],
  topics: [{ name: "Lançamento da versão 2", status: "completed" }],
  currentTopic: "Lançamento da versão 2",
  decisions: [{ text: "Lançar na sexta-feira", chunkId: "chunk_1", classification: "finalized" }],
  actionItems: [{ task: "Preparar o changelog", owner: "Bruno", deadline: "quinta-feira" }],
  sentiment: "positive",
  keyInsights: [],
  contradictions: [],
  questionsRaised: ["Qual o preço do plano empresarial?"],
};
/** What the model answers to a summary pass. */
let summaryResponse: AnyRecord = DEFAULT_SUMMARY;
/** What the model answers to the review of the record at the end (raw content). */
let consolidationContent = "{}";
/** An HTTP error the provider answers to the review instead (none by default). */
let consolidationError: { status: number; body: unknown } | null = null;
/** When set, ValorBrain answers a delivery only once this settles. */
let storeGate: Promise<void> | null = null;

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
  if (
    url === "https://api.z.ai/api/coding/paas/v4/chat/completions" &&
    /revisa o registro/.test(chatSystemPrompt(init))
  ) {
    if (consolidationError) return jsonResponse(consolidationError.status, consolidationError.body);
    return jsonResponse(200, {
      choices: [{ finish_reason: "stop", message: { content: consolidationContent } }],
      usage: { prompt_tokens: 1500, completion_tokens: 200, total_tokens: 1700 },
    });
  }
  if (url === "https://api.z.ai/api/coding/paas/v4/chat/completions") {
    return jsonResponse(200, {
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(summaryResponse) } }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    });
  }
  if (url === "https://valorbrain-api.valor.digital/api/v1/memory/store") {
    if (storeGate) await storeGate;
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
      getManifest: () => ({ version: "2.4.0" }),
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
const { buildValorBrainContent } = await import("./vbClient.ts");

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
  // Four items are too few for the model's review of the record: only the local one ran.
  assert.ok(
    !fetchCalls.some(
      (c) =>
        c.url.endsWith("/chat/completions") && /revisa o registro/.test(chatSystemPrompt(c.init)),
    ),
  );
  assert.equal(saved.consolidation.mode, "local");
  assert.deepEqual(saved.consolidation.after, {
    decisions: 1,
    actionItems: 1,
    topics: 1,
    openPoints: 1,
  });
  assert.equal(saved.appVersion, "2.4.0", "the record says which version wrote it");

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
  assert.match(payload.content, /\n- Registrado pelo ValorBrain Meet 2\.4\.0 \(transcrição/);

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
  assert.match(summaryUser, /Quem gravou a reunião: Gustavo\.\n<\/participantes>/);
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

test("everyone who attended is saved, even after they left or the user hung up", async () => {
  const savedSessions = () => (localStore.savedSessionIndex as AnyRecord[] | undefined) ?? [];
  const savedBefore = savedSessions().length;
  fetchCalls.length = 0;
  const start = await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "abc-defg-hij",
    meetingUrl: MEET_URL,
    streamId: "stream-6",
  });
  assert.equal(start.success, true, JSON.stringify(start));

  const sender = { tab: { id: TAB_ID, url: MEET_URL } };
  await sendMessage(
    { type: "PARTICIPANTS_UPDATED", participants: ["Ana", "Bruno", "Você", "You"] },
    sender,
  );
  sttResponses.push({
    text: "Fechamos o escopo da integração.",
    duration: 4,
    segments: [
      { text: " Fechamos o escopo da integração.", no_speech_prob: 0.02, avg_logprob: -0.3 },
    ],
  });
  await sendMessage({
    type: "OFFSCREEN_AUDIO_CHUNK",
    audioBase64: fakeChunk(),
    mimeType: "audio/webm;codecs=opus",
    source: "tab",
    startedAt: Date.now() - 4000,
    endedAt: Date.now(),
  });
  await waitFor(
    async () => (await sendMessage({ type: "GET_STATE" })).stats?.chunksTranscribed === 1,
    "line transcribed",
  );

  // Bruno leaves, then the user hangs up: Meet shows nobody while the meeting is saved.
  await sendMessage({ type: "PARTICIPANTS_UPDATED", participants: ["Ana"] }, sender);
  await sendMessage({ type: "PARTICIPANTS_UPDATED", participants: [] }, sender);
  const live = await sendMessage({ type: "GET_STATE" });
  assert.deepEqual(live.participants, [], "the live list is who is in the call now");
  assert.deepEqual(live.attendees, ["Ana", "Bruno"], "no placeholders, nobody dropped");

  await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  const index = await waitFor(
    () => (savedSessions().length === savedBefore + 1 ? savedSessions() : null),
    "session saved",
  );
  const saved = localStore[`savedSession:${index[0].id}`];
  assert.deepEqual(saved.participants, ["Ana", "Bruno"]);
  assert.match(buildValorBrainContent(saved), /\n## Participantes\nAna, Bruno\n/);

  // The final review and summary still know who was there.
  const chatUser = (pattern: RegExp) =>
    JSON.parse(
      String(
        fetchCalls.find(
          (c) => c.url.endsWith("/chat/completions") && pattern.test(chatSystemPrompt(c.init)),
        )!.init.body,
      ),
    ).messages[1].content as string;
  assert.match(chatUser(/revisa a grafia/), /\n<participantes>\n.*Ana, Bruno\n<\/participantes>/);
  assert.match(
    chatUser(/motor de inteligência/),
    /\n<participantes>\nParticipantes detectados na reunião: .*Ana, Bruno\./,
  );
});

/** The record of a sales call as the live summary leaves it: 10 items, most of them noise. */
const SALES_CALL_SUMMARY: AnyRecord = {
  summary: "Leonardo apresentou o programa de mentoria; Gustavo decidiu não aderir agora.",
  summaryItems: [],
  topics: [
    { name: "Programa de mentoria", status: "active" },
    { name: "Preço do programa", status: "active" },
  ],
  currentTopic: "Preço do programa",
  decisions: [
    {
      text: "Leonardo apresenta a metodologia do programa",
      chunkId: "chunk_1",
      classification: "finalized",
    },
    { text: "Pacote completo por 22.990", chunkId: "chunk_1", classification: "tentative" },
    {
      text: "Gustavo decide não aderir agora",
      by: "Gustavo",
      chunkId: "chunk_1",
      classification: "tentative",
    },
  ],
  actionItems: [
    { task: "Enviar o link da reunião para o Gustavo entrar", confidence: "high" },
    { task: "Desenhar a carta de apresentação do Gustavo", owner: "Leonardo", deadline: "sexta" },
  ],
  sentiment: "neutral",
  keyInsights: [],
  contradictions: [],
  unresolvedDiscussions: ["Qual é o valor do serviço"],
  questionsRaised: ["Qual é o valor do serviço?", "Tudo bem com vocês?"],
};

function isReviewCall(c: { url: string; init: RequestInit }): boolean {
  return c.url.endsWith("/chat/completions") && /revisa o registro/.test(chatSystemPrompt(c.init));
}

/** One short recording, stopped and saved; returns the saved session. */
async function recordAndSave(streamId: string): Promise<AnyRecord> {
  const savedBefore = (localStore.savedSessionIndex as AnyRecord[]).length;
  const start = await sendMessage({
    type: "MANUAL_START_AUDIO",
    tabId: TAB_ID,
    meetingId: "abc-defg-hij",
    meetingUrl: MEET_URL,
    streamId,
  });
  assert.equal(start.success, true, JSON.stringify(start));
  const text = "Eu não vou aderir agora, mas mande a carta de apresentação.";
  sttResponses.push({
    text,
    duration: 5,
    segments: [{ text: ` ${text}`, no_speech_prob: 0.02, avg_logprob: -0.2 }],
  });
  await sendMessage({
    type: "OFFSCREEN_AUDIO_CHUNK",
    audioBase64: fakeChunk(),
    mimeType: "audio/webm;codecs=opus",
    startedAt: Date.now() - 5000,
    endedAt: Date.now(),
  });
  await waitFor(async () => {
    const s = await sendMessage({ type: "GET_STATE" });
    return s.stats?.chunksTranscribed === 1 ? s : null;
  }, "chunk transcribed");
  await sendMessage({ type: "MANUAL_STOP_AUDIO" });
  const index = await waitFor(
    () =>
      (localStore.savedSessionIndex as AnyRecord[]).length === savedBefore + 1
        ? (localStore.savedSessionIndex as AnyRecord[])
        : null,
    "session saved",
  );
  return localStore[`savedSession:${index[0].id}`];
}

test("the record is reviewed by the model, checked and merged before it is saved", async () => {
  fetchCalls.length = 0;
  summaryResponse = SALES_CALL_SUMMARY;
  consolidationContent = JSON.stringify({
    decisions: [{ keep: "D3", classification: "finalized" }],
    actionItems: [{ keep: "a2", owner: "Ricardo" }],
    topics: [{ keep: "T1", same: ["T2"], status: "completed" }],
    openPoints: [],
  });
  try {
    const saved = await recordAndSave("stream-6");

    assert.deepEqual(saved.decisions, [
      {
        text: "Gustavo decide não aderir agora",
        by: "Gustavo",
        chunkId: "chunk_1",
        classification: "finalized",
      },
    ]);
    // "Ricardo" is not in this meeting: the owner the summary found stays.
    assert.deepEqual(
      saved.actionItems.map((a: AnyRecord) => [a.task, a.owner]),
      [["Desenhar a carta de apresentação do Gustavo", "Leonardo"]],
    );
    assert.deepEqual(saved.topics, [{ name: "Programa de mentoria", status: "completed" }]);
    assert.deepEqual(saved.unresolvedDiscussions, []);
    assert.deepEqual(saved.questionsRaised, []);
    assert.equal(saved.consolidation.mode, "model");
    assert.deepEqual(saved.consolidation.before, {
      decisions: 3,
      actionItems: 2,
      topics: 2,
      openPoints: 3,
    });
    assert.deepEqual(saved.consolidation.after, {
      decisions: 1,
      actionItems: 1,
      topics: 1,
      openPoints: 0,
    });

    // One request after the final summary: deterministic, JSON, room for GLM to reason.
    const summaryIndex = fetchCalls.findIndex(
      (c) =>
        c.url.endsWith("/chat/completions") &&
        /motor de inteligência/.test(chatSystemPrompt(c.init)),
    );
    const reviewCalls = fetchCalls.filter(isReviewCall);
    assert.equal(reviewCalls.length, 1);
    assert.ok(summaryIndex >= 0 && fetchCalls.indexOf(reviewCalls[0]) > summaryIndex);
    const body = JSON.parse(String(reviewCalls[0].init.body));
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 6000);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(body.messages[1].content, /\nD3 Gustavo decide não aderir agora — por: Gustavo/);
    assert.match(body.messages[1].content, /Quem gravou a reunião: Gustavo\.\n<\/participantes>/);

    // The document sent to ValorBrain carries the reviewed record and nothing about the review.
    const store = await waitFor(
      () => fetchCalls.find((c) => c.url.endsWith("/api/v1/memory/store")),
      "ValorBrain delivery",
    );
    const payload = JSON.parse(String(store.init.body));
    assert.match(payload.content, /## Decisões\n- Gustavo decide não aderir agora — Gustavo\n\n/);
    assert.doesNotMatch(payload.content, /metodologia|22\.990|Tudo bem com vocês/);
    assert.doesNotMatch(payload.content, /Registro revisado|revisão local/);

    // What the review removed stays on the saved meeting, where the side panel can put it back.
    const original = saved.consolidation.original;
    assert.deepEqual(
      original.decisions.map((d: AnyRecord) => d.text),
      SALES_CALL_SUMMARY.decisions.map((d: AnyRecord) => d.text),
    );
    assert.deepEqual(original.questionsRaised, SALES_CALL_SUMMARY.questionsRaised);
    const key = `savedSession:${saved.id}`;
    await waitFor(() => localStore[key]?.vb?.status === "sent", "delivery recorded");
    // Undone while the meeting is being sent again: the resend does not bring the review back.
    let release = () => {};
    storeGate = new Promise((resolve) => (release = resolve));
    const deliveries = () => fetchCalls.filter((c) => c.url.endsWith("/api/v1/memory/store"));
    const sentBefore = deliveries().length;
    const resend = sendMessage({ type: "VB_SEND_SESSION", sessionId: saved.id });
    await waitFor(() => deliveries().length > sentBefore, "resend under way");
    const undo = await sendMessage({ type: "UNDO_RECORD_REVIEW", sessionId: saved.id });
    assert.equal(undo.success, true, JSON.stringify(undo));
    storeGate = null;
    release();
    assert.equal((await resend).ok, true);
    const restored = localStore[key];
    for (const list of [
      "decisions",
      "actionItems",
      "topics",
      "unresolvedDiscussions",
      "questionsRaised",
    ]) {
      assert.deepEqual(restored[list], original[list], list);
    }
    assert.equal(restored.consolidation.undone, true);
    assert.equal(restored.consolidation.original, undefined);
    assert.deepEqual(restored.consolidation.after, saved.consolidation.after);
    assert.equal(restored.vb.status, "sent");
    const listed = (localStore.savedSessionIndex as AnyRecord[]).find((s) => s.id === saved.id)!;
    assert.equal(listed.decisions.length, 3, "the history shows the lists put back");
    // Nothing is left to undo.
    const again = await sendMessage({ type: "UNDO_RECORD_REVIEW", sessionId: saved.id });
    assert.equal(again.success, false);
  } finally {
    summaryResponse = DEFAULT_SUMMARY;
    consolidationContent = "{}";
  }
});

test("without the model's review, repeats are still merged before saving", async () => {
  summaryResponse = SALES_CALL_SUMMARY;
  try {
    // A refused answer (it would empty the record): the local review runs instead.
    fetchCalls.length = 0;
    consolidationContent = JSON.stringify({
      decisions: [],
      actionItems: [],
      topics: [],
      openPoints: [],
    });
    const refused = await recordAndSave("stream-7");
    assert.equal(fetchCalls.filter(isReviewCall).length, 1);
    assert.equal(refused.consolidation.mode, "local");
    assert.equal(refused.decisions.length, 3);
    assert.deepEqual(refused.unresolvedDiscussions, ["Qual é o valor do serviço"]);
    assert.deepEqual(refused.questionsRaised, ["Tudo bem com vocês?"], "the repeat was merged");
    assert.equal(refused.consolidation.before.openPoints, 3);
    assert.equal(refused.consolidation.after.openPoints, 2);

    // Text around the object: it may be the prompt's example, so the answer is refused.
    fetchCalls.length = 0;
    consolidationContent = `Segue a revisão:\n${JSON.stringify({ decisions: ["D3"] })}`;
    const wrapped = await recordAndSave("stream-7b");
    assert.equal(fetchCalls.filter(isReviewCall).length, 1);
    assert.equal(wrapped.consolidation.mode, "local");
    assert.equal(wrapped.decisions.length, 3);

    // The setting off: no request at all, the local review still runs.
    fetchCalls.length = 0;
    localStore.settings = { ...localStore.settings, recordConsolidation: false };
    const off = await recordAndSave("stream-8");
    assert.equal(fetchCalls.filter(isReviewCall).length, 0);
    assert.equal(off.consolidation.mode, "local");
    assert.equal(off.decisions.length, 3);
    assert.equal(off.consolidation.after.openPoints, 2);
  } finally {
    summaryResponse = DEFAULT_SUMMARY;
    consolidationContent = "{}";
    delete localStore.settings.recordConsolidation;
  }
});

// Keep last: the quota pause lasts for the rest of this process.
test("a quota error on the review pauses the provider and the record is reviewed locally", async () => {
  summaryResponse = SALES_CALL_SUMMARY;
  consolidationError = {
    status: 429,
    body: {
      error: {
        code: "1308",
        message: "Usage limit reached for 5 hour. Your limit will reset at 2099-01-01 00:00:00",
      },
    },
  };
  try {
    fetchCalls.length = 0;
    const first = await recordAndSave("stream-9");
    assert.equal(fetchCalls.filter(isReviewCall).length, 1, "a quota error is not retried");
    assert.equal(first.consolidation.mode, "local");
    assert.equal(first.decisions.length, 3);
    assert.equal(first.consolidation.after.openPoints, 2);

    // Until the quota renews nothing more goes to the summary provider.
    fetchCalls.length = 0;
    const second = await recordAndSave("stream-10");
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/chat/completions")).length, 0);
    assert.equal(second.consolidation.mode, "local");
  } finally {
    summaryResponse = DEFAULT_SUMMARY;
    consolidationError = null;
  }
});
