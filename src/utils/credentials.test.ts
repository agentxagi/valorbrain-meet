import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  getApiCredentials,
  getOpenAiApiKey,
  saveApiCredentials,
  unlockCredentials,
  lockCredentials,
  isUnlocked,
} from "./credentials.ts";

type StorageArea = Record<string, unknown>;

function setupChromeStorage(sessionInitial: StorageArea = {}, localInitial: StorageArea = {}) {
  // Ensure basic mock exists so lockCredentials can run without ReferenceError
  if (!(globalThis as any).chrome) {
    (globalThis as any).chrome = {
      storage: {
        session: {
          async remove() {},
        },
      },
    };
  }

  lockCredentials();

  const session: StorageArea = sessionInitial;
  const local: StorageArea = localInitial;

  function createStorageArea(store: StorageArea) {
    return {
      async get(keys: string | string[]) {
        const keyList = Array.isArray(keys) ? keys : [keys];
        return keyList.reduce<StorageArea>((result, key) => {
          result[key] = store[key];
          return result;
        }, {});
      },
      async set(values: StorageArea) {
        Object.assign(store, values);
      },
      async remove(keys: string | string[]) {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) {
          delete store[key];
        }
      },
    };
  }

  (globalThis as any).chrome = {
    storage: {
      session: createStorageArea(session),
      local: createStorageArea(local),
    },
  };

  return { session, local };
}

test("isUnlocked returns false initially", () => {
  setupChromeStorage();
  assert.equal(isUnlocked(), false);
});

test("unlock on first run generates salt and caches key", async () => {
  const { local } = setupChromeStorage();

  assert.equal(isUnlocked(), false);
  const result = await unlockCredentials("test-passphrase");
  assert.equal(result, true);
  assert.equal(isUnlocked(), true);

  assert.ok(typeof local.credential_encryption_salt === "string");
  assert.equal(local.credential_encryption_seed, undefined);
});

test("unlock with wrong passphrase returns false", async () => {
  setupChromeStorage();

  await unlockCredentials("correct-passphrase");
  assert.equal(isUnlocked(), true);

  await saveApiCredentials({ openai_api_key: "secret-key" });

  lockCredentials();
  assert.equal(isUnlocked(), false);

  const result = await unlockCredentials("wrong-passphrase");
  assert.equal(result, false);
  assert.equal(isUnlocked(), false);
});

test("unlock with correct passphrase after lock returns true", async () => {
  setupChromeStorage();

  await unlockCredentials("correct-passphrase");
  await saveApiCredentials({ openai_api_key: "secret-key" });

  lockCredentials();
  const result = await unlockCredentials("correct-passphrase");
  assert.equal(result, true);
  assert.equal(isUnlocked(), true);
});

test("save writes plaintext to session and encrypted to local", async () => {
  const { session, local } = setupChromeStorage();

  await unlockCredentials("test-passphrase");
  await saveApiCredentials({ openai_api_key: "sk-test-123" });

  assert.equal(session.openai_api_key, "sk-test-123");

  assert.ok(typeof local.openai_api_key === "string");
  assert.ok((local.openai_api_key as string).startsWith("enc:"));
  assert.notEqual(local.openai_api_key, "sk-test-123");
});

test("getApiCredentials returns plaintext from session when available", async () => {
  setupChromeStorage({ openai_api_key: "session-key" }, {});

  const creds = await getApiCredentials();
  assert.equal(creds.openai_api_key, "session-key");
});

test("getApiCredentials decrypts local credentials when session is empty", async () => {
  const { session } = setupChromeStorage();

  await unlockCredentials("test-passphrase");
  await saveApiCredentials({ openai_api_key: "persisted-key" });

  delete session.openai_api_key;

  const creds = await getApiCredentials();
  assert.equal(creds.openai_api_key, "persisted-key");
});

test("getOpenAiApiKey returns the stored key", async () => {
  setupChromeStorage({ openai_api_key: "openai-foo" }, {});

  assert.equal(await getOpenAiApiKey(), "openai-foo");
});

test("clearing credentials removes from both local and session", async () => {
  const { session, local } = setupChromeStorage();

  await unlockCredentials("test-passphrase");
  await saveApiCredentials({ openai_api_key: "will-clear" });
  assert.ok(session.openai_api_key);
  assert.ok(local.openai_api_key);

  await saveApiCredentials({ openai_api_key: "" });

  assert.deepEqual(session.openai_api_key, undefined);
  assert.deepEqual(local.openai_api_key, undefined);
});

test("saving credentials trims whitespace", async () => {
  const { session, local } = setupChromeStorage();

  await unlockCredentials("test-passphrase");
  await saveApiCredentials({
    openai_api_key: "  spaced-key  ",
  });

  assert.equal(session.openai_api_key, "spaced-key");
  assert.ok((local.openai_api_key as string).startsWith("enc:"));
});

test("encrypted credentials survive simulated restart with same passphrase", async () => {
  const session1: StorageArea = {};
  const local1: StorageArea = {};
  setupChromeStorage(session1, local1);

  await unlockCredentials("survival-passphrase");
  await saveApiCredentials({ openai_api_key: "survive-key" });

  lockCredentials();
  const session2: StorageArea = {};
  setupChromeStorage(session2, local1);

  await unlockCredentials("survival-passphrase");
  const creds = await getApiCredentials();
  assert.equal(creds.openai_api_key, "survive-key");
});

test("wrong passphrase after restart returns no credentials", async () => {
  const session1: StorageArea = {};
  const local1: StorageArea = {};
  setupChromeStorage(session1, local1);

  await unlockCredentials("correct-passphrase");
  await saveApiCredentials({ openai_api_key: "my-secret-key" });

  lockCredentials();
  const session2: StorageArea = {};
  setupChromeStorage(session2, local1);

  const result = await unlockCredentials("wrong-passphrase");
  assert.equal(result, false);

  const creds = await getApiCredentials();
  assert.equal(creds.openai_api_key, undefined);
});

test("encryption operations are blocked without derived key", async () => {
  setupChromeStorage();
  assert.equal(isUnlocked(), false);

  await chrome.storage.local.set({
    openai_api_key: "enc:somegarbage",
    credential_encryption_salt: "dGVzdC1zYWx0",
  });

  const creds = await getApiCredentials();
  assert.equal(creds.openai_api_key, undefined);
});

test("saving partial credentials does not wipe out omitted keys", async () => {
  const { session, local } = setupChromeStorage(
    { openai_api_key: "existing-openai" },
    { openai_api_key: "existing-openai" },
  );

  await unlockCredentials("test-passphrase");

  // An empty credentials object omits every key — storage stays untouched.
  await saveApiCredentials({});

  assert.deepEqual(session, {
    openai_api_key: "existing-openai",
  });
  assert.equal(local.openai_api_key, "existing-openai");
});

after(() => {
  lockCredentials();
});
