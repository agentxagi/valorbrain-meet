import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_PROFILES,
  getProviderConfig,
  getProviderProfile,
  joinProviderUrl,
  migrateProviderSettings,
  normalizeBaseUrl,
  normalizeProviderConfig,
  providerConfigFromProfile,
  resolveProviderApiKey,
  saveProviderConfig,
  storageKeyFor,
} from "./providerSettings.ts";
import {
  getOpenAiApiKey,
  saveApiCredentials,
  unlockCredentials,
  lockCredentials,
} from "./credentials.ts";

type StorageArea = Record<string, unknown>;

interface TestStorageArea {
  get(keys: string | string[]): Promise<StorageArea>;
  set(items: StorageArea): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function createStorageArea(store: StorageArea): TestStorageArea {
  return {
    async get(keys: string | string[]) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      return keyList.reduce<StorageArea>((result, key) => {
        result[key] = store[key];
        return result;
      }, {});
    },
    async set(items: StorageArea) {
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        delete store[key];
      }
    },
  };
}

function setupChromeStorage(localInitial: StorageArea = {}) {
  const local: StorageArea = { ...localInitial };
  const session: StorageArea = {};
  const area = createStorageArea(local);
  // Reflect.set bypasses the @types/chrome global namespace type; the stub
  // only implements the surface this test exercises.
  Reflect.set(globalThis, "chrome", {
    storage: { local: area, session: createStorageArea(session) },
  });
  return { local, session, area };
}

test("built-in profiles carry the PRD defaults", () => {
  const whisper = getProviderProfile("whisper-local")!;
  const zai = getProviderProfile("zai")!;
  const openai = getProviderProfile("openai")!;

  assert.equal(whisper.baseUrl, "http://127.0.0.1:8394/v1");
  assert.equal(whisper.model, "whisper-local");
  assert.equal(zai.baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(zai.model, "glm-5.3-flash");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.model, "gpt-4o-mini");
  assert.equal(getProviderProfile("custom"), null);
  assert.equal(PROVIDER_PROFILES.length, 3);
});

test("getProviderConfig falls back to role defaults when nothing is stored", async () => {
  const { area } = setupChromeStorage();

  const transcription = await getProviderConfig("transcription", area);
  const summary = await getProviderConfig("summary", area);

  assert.equal(transcription.profile, "whisper-local");
  assert.equal(transcription.baseUrl, "http://127.0.0.1:8394/v1");
  assert.equal(transcription.model, "whisper-local");
  assert.equal(transcription.apiKey, "");

  assert.equal(summary.profile, "zai");
  assert.equal(summary.baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(summary.model, "glm-5.3-flash");
});

test("normalizeProviderConfig trims the base URL and falls back on invalid fields", () => {
  const normalized = normalizeProviderConfig("summary", {
    profile: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4///",
    apiKey: "  key-1  ",
    model: "",
  });

  assert.equal(normalized.baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(normalized.apiKey, "key-1");
  assert.equal(normalized.model, "glm-5.3-flash");

  const unknownProfile = normalizeProviderConfig("transcription", { profile: "nope" });
  assert.equal(unknownProfile.profile, "whisper-local");
  assert.equal(unknownProfile.baseUrl, "http://127.0.0.1:8394/v1");

  const custom = normalizeProviderConfig("summary", {
    profile: "custom",
    baseUrl: "https://llm.example.com/v1",
    model: "mistral-small",
  });
  assert.equal(custom.profile, "custom");
  assert.equal(custom.baseUrl, "https://llm.example.com/v1");
  assert.equal(custom.model, "mistral-small");
});

test("normalizeBaseUrl strips trailing slashes only", () => {
  assert.equal(normalizeBaseUrl("  https://api.example.com/v1/  "), "https://api.example.com/v1");
  assert.equal(
    joinProviderUrl("https://api.example.com/v1/", "/chat/completions"),
    "https://api.example.com/v1/chat/completions",
  );
  assert.equal(
    joinProviderUrl("https://api.z.ai/api/paas/v4", "/chat/completions"),
    "https://api.z.ai/api/paas/v4/chat/completions",
  );
});

test("saveProviderConfig round-trips a block per role", async () => {
  const { area } = setupChromeStorage();

  await saveProviderConfig(
    "transcription",
    {
      profile: "custom",
      baseUrl: "http://192.168.1.20:8394/v1/",
      apiKey: "",
      model: "whisper-local",
    },
    area,
  );
  await saveProviderConfig(
    "summary",
    {
      profile: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "zai-key",
      model: "glm-5.3-flash",
    },
    area,
  );

  const transcription = await getProviderConfig("transcription", area);
  const summary = await getProviderConfig("summary", area);

  assert.equal(transcription.baseUrl, "http://192.168.1.20:8394/v1");
  assert.equal(transcription.profile, "custom");
  assert.equal(summary.apiKey, "zai-key");
  assert.equal(storageKeyFor("transcription"), "provider.transcription");
  assert.equal(storageKeyFor("summary"), "provider.summary");
});

test("resolveProviderApiKey prefers the block key and only OpenAI falls back to the vault", async () => {
  setupChromeStorage();
  await unlockCredentials("test-passphrase");
  await saveApiCredentials({ openai_api_key: "sk-vault-key" });
  assert.equal(await getOpenAiApiKey(), "sk-vault-key");

  const zaiWithKey = await resolveProviderApiKey({
    profile: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKey: "zai-key",
    model: "glm-5.3-flash",
  });
  assert.equal(zaiWithKey, "zai-key");

  const openaiFallback = await resolveProviderApiKey({
    profile: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  });
  assert.equal(openaiFallback, "sk-vault-key");

  const localWithoutKey = await resolveProviderApiKey({
    profile: "whisper-local",
    baseUrl: "http://127.0.0.1:8394/v1",
    apiKey: "",
    model: "whisper-local",
  });
  assert.equal(localWithoutKey, null);
});

test("migration points both roles at OpenAI when only a legacy credential exists", async () => {
  const { area } = setupChromeStorage({
    openai_api_key: "enc:legacy-ciphertext",
    settings: { aiModel: "gpt-4o" },
  });

  const result = await migrateProviderSettings(area);
  assert.equal(result.migrated, true);

  const transcription = await getProviderConfig("transcription", area);
  const summary = await getProviderConfig("summary", area);

  assert.equal(transcription.profile, "openai");
  assert.equal(transcription.baseUrl, "https://api.openai.com/v1");
  assert.equal(transcription.model, "gpt-4o-mini");
  assert.equal(transcription.apiKey, "");

  assert.equal(summary.profile, "openai");
  assert.equal(summary.model, "gpt-4o");
  assert.equal(summary.apiKey, "");
});

test("migration keeps provider blocks that already exist", async () => {
  const { area, local } = setupChromeStorage({
    openai_api_key: "enc:legacy-ciphertext",
    "provider.summary": {
      profile: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "kept",
      model: "glm-5.3-flash",
    },
  });

  const result = await migrateProviderSettings(area);
  assert.equal(result.migrated, false);

  const summary = await getProviderConfig("summary", area);
  assert.equal(summary.apiKey, "kept");
  assert.equal(local["provider.transcription"], undefined);
});

test("migration is a no-op without a legacy credential, leaving defaults in place", async () => {
  const { area, local } = setupChromeStorage({ settings: { theme: "dark" } });

  const result = await migrateProviderSettings(area);
  assert.equal(result.migrated, false);
  assert.equal(local["provider.transcription"], undefined);
  assert.equal(local["provider.summary"], undefined);

  const transcription = await getProviderConfig("transcription", area);
  assert.equal(transcription.profile, "whisper-local");
});

test("providerConfigFromProfile builds a probe block from a preset", () => {
  const config = providerConfigFromProfile("openai", "sk-probe");
  assert.equal(config.profile, "openai");
  assert.equal(config.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.model, "gpt-4o-mini");
  assert.equal(config.apiKey, "sk-probe");
});

after(() => {
  // Clear the credentials auto-lock timer so the test process can exit.
  lockCredentials();
});
