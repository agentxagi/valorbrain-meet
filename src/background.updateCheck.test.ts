/**
 * The update notice in the service worker, with a mocked Chrome runtime and a
 * mocked meet.valorbra.in:
 *
 *   popup/settings open → CHECK_FOR_UPDATE → latest.json at most once a day
 *   browser start / extension update → the same check (an update also drops
 *   the notice about the version just installed)
 *   setting off → no request, stored result removed
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

const LATEST_URL = "https://meet.valorbra.in/latest.json";
const DAY_MS = 24 * 60 * 60 * 1000;

const localStore: AnyRecord = { settings: {}, onboardingCompleted: true };
let messageListener: MessageListener | undefined;
const installedListeners: Array<() => unknown> = [];
const startupListeners: Array<() => unknown> = [];
let installedVersion = "2.4.0";
const SITE_VERSION = "2.5.0";
let siteDown = false;
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  fetchCalls.push({ url, init });
  if (url === LATEST_URL && !siteDown) {
    return new Response(
      JSON.stringify({
        version: SITE_VERSION,
        file: `valorbrain-meet-v${SITE_VERSION}.zip`,
        url: `https://meet.valorbra.in/downloads/valorbrain-meet-v${SITE_VERSION}.zip`,
        sha256: "b".repeat(64),
        size: 200000,
        released: "2026-10-01T12:00:00.000Z",
        notes: `https://github.com/agentxagi/valorbrain-meet/releases/tag/v${SITE_VERSION}`,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response("indisponível", { status: 503 });
}) as typeof fetch;

function createStorageArea(store: AnyRecord) {
  return {
    async get(keys?: string | string[] | null) {
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : [];
      const out: AnyRecord = {};
      for (const key of keys == null ? Object.keys(store) : list) {
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
  };
}

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
      getManifest: () => ({ version: installedVersion }),
      getContexts: async () => [],
      sendMessage: async () => undefined,
      onMessage: {
        addListener: (cb: MessageListener) => {
          messageListener = cb;
        },
      },
      onInstalled: { addListener: (cb: () => unknown) => installedListeners.push(cb) },
      onStartup: { addListener: (cb: () => unknown) => startupListeners.push(cb) },
      onSuspend: ignored,
    },
    tabs: {
      onUpdated: ignored,
      onActivated: ignored,
      onRemoved: ignored,
      query: async () => [],
      create: async () => ({}),
    },
    commands: { onCommand: ignored },
    contextMenus: {
      onClicked: ignored,
      removeAll: (callback?: () => void) => callback?.(),
      create: () => {},
    },
    storage: {
      local: createStorageArea(localStore),
      session: createStorageArea({}),
      onChanged: ignored,
    },
  };
}

installChromeMock();
await import("./background.ts");

function sendMessage(message: AnyRecord): Promise<AnyRecord> {
  return new Promise((resolve) => {
    assert.ok(messageListener, "background must register a runtime.onMessage listener");
    const kept = messageListener!(message, {}, (response) =>
      resolve((response ?? {}) as AnyRecord),
    );
    if (kept !== true) resolve({});
  });
}

async function waitFor<T>(probe: () => T, label: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const latestCalls = () => fetchCalls.filter((c) => c.url === LATEST_URL).length;

test("opening the popup or the settings checks once a day, with a plain GET", async () => {
  const first = await sendMessage({ type: "CHECK_FOR_UPDATE" });
  assert.equal(first.success, true);
  assert.equal(first.status.available, true);
  assert.equal(first.status.latestVersion, "2.5.0");
  assert.deepEqual(localStore.updateStatus, first.status);

  assert.equal(fetchCalls.length, 1);
  const { url, init } = fetchCalls[0];
  assert.equal(url, LATEST_URL);
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.equal(init.headers, undefined, "no custom headers");
  assert.equal(init.body, undefined);

  await sendMessage({ type: "CHECK_FOR_UPDATE" });
  assert.equal(latestCalls(), 1, "not again within the day");

  // Popup and settings opening together: one request.
  delete localStore.updateStatus;
  await Promise.all([
    sendMessage({ type: "CHECK_FOR_UPDATE" }),
    sendMessage({ type: "CHECK_FOR_UPDATE" }),
  ]);
  assert.equal(latestCalls(), 2);

  const forced = await sendMessage({ type: "CHECK_FOR_UPDATE", force: true });
  assert.equal(latestCalls(), 3, "Verificar agora asks right away");
  assert.equal(forced.status.ok, true);
});

test("an unreachable site never fails the message and keeps the known update", async () => {
  siteDown = true;
  const response = await sendMessage({ type: "CHECK_FOR_UPDATE", force: true });
  siteDown = false;
  assert.equal(response.success, true);
  assert.equal(response.status.ok, false);
  assert.equal(response.status.latestVersion, "2.5.0");
  assert.equal(response.status.available, true);
});

test("turned off: no request, and the stored result is removed", async () => {
  localStore.settings = { updateCheck: false };
  const before = latestCalls();
  const response = await sendMessage({ type: "CHECK_FOR_UPDATE", force: true });
  assert.equal(response.status, null);
  assert.equal("updateStatus" in localStore, false);
  for (const listener of [...startupListeners, ...installedListeners]) await listener();
  await sendMessage({ type: "CHECK_FOR_UPDATE" });
  assert.equal(latestCalls(), before, "nothing is fetched while it is off");
  localStore.settings = {};
});

test("the browser start checks when a day has passed", async () => {
  localStore.updateStatus = {
    checkedAt: Date.now() - DAY_MS - 60_000,
    ok: true,
    latestVersion: "2.4.0",
    available: false,
  };
  const before = latestCalls();
  for (const listener of startupListeners) await listener();
  const status = await waitFor(
    () => (localStore.updateStatus?.latestVersion === "2.5.0" ? localStore.updateStatus : null),
    "the startup check",
  );
  assert.equal(latestCalls(), before + 1);
  assert.equal(status.available, true);
});

test("after updating, the notice about the version just installed goes away", async () => {
  installedVersion = "2.5.0";
  localStore.updateStatus = {
    checkedAt: Date.now() - 60_000,
    ok: true,
    latestVersion: "2.5.0",
    available: true,
  };
  const before = latestCalls();
  for (const listener of installedListeners) await listener();
  await waitFor(() => localStore.updateStatus?.available === false, "the outdated flag cleared");
  assert.equal(latestCalls(), before, "a recent check is not repeated");
  assert.equal(localStore.updateStatus.latestVersion, "2.5.0");
});

test("going back to an older version brings the notice back", async () => {
  installedVersion = "2.4.0";
  const before = latestCalls();
  for (const listener of installedListeners) await listener();
  await waitFor(() => localStore.updateStatus?.available === true, "the flag set again");
  assert.equal(latestCalls(), before, "from the stored result, without asking the site");
});
