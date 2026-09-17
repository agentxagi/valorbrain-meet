/**
 * @fileoverview Provider-agnostic AI provider settings.
 *
 * Transcription and summarization each have an independent provider block
 * stored in `chrome.storage.local` under `provider.transcription` and
 * `provider.summary` (the `provider.*` prefix avoids colliding with other
 * settings namespaces). Every block follows the OpenAI wire format:
 *
 * - Chat:     `POST {baseUrl}/chat/completions`
 * - Audio:    `POST {baseUrl}/audio/transcriptions` (multipart)
 * - Validate: `GET  {baseUrl}/models`
 *
 * Built-in profiles only pre-fill the editable fields; any OpenAI-compatible
 * endpoint works through the same schema.
 */

import { getOpenAiApiKey } from "./credentials";

/** Which pipeline stage a provider block drives. */
export type ProviderRole = "transcription" | "summary";

/** Built-in profile ids plus `custom` for hand-edited blocks. */
export type ProviderProfileId = "whisper-local" | "zai" | "openai" | "custom";

/** A ready-made provider preset offered in the options dropdown. */
export interface ProviderProfile {
  id: Exclude<ProviderProfileId, "custom">;
  label: string;
  baseUrl: string;
  model: string;
}

/** Editable provider configuration for one pipeline stage. */
export interface ProviderConfig {
  profile: ProviderProfileId;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Minimal storage surface used by this module (subset of `chrome.storage.local`). */
export interface ProviderStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Built-in profiles shown in the options dropdown. */
export const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: "whisper-local",
    label: "Local Whisper (faster-whisper)",
    baseUrl: "http://127.0.0.1:8394/v1",
    model: "whisper-local",
  },
  {
    id: "zai",
    label: "Z.ai GLM",
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-5.3-flash",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
];

/** Profile used when a role has no stored configuration yet. */
const DEFAULT_ROLE_PROFILE: Record<ProviderRole, Exclude<ProviderProfileId, "custom">> = {
  transcription: "whisper-local",
  summary: "zai",
};

const STORAGE_KEY_PREFIX = "provider.";

/** Storage key holding the provider block for a role (`provider.<role>`). */
export function storageKeyFor(role: ProviderRole): string {
  return `${STORAGE_KEY_PREFIX}${role}`;
}

/** Returns the built-in profile with the given id, or `null` for `custom`/unknown ids. */
export function getProviderProfile(id: string): ProviderProfile | null {
  return PROVIDER_PROFILES.find((profile) => profile.id === id) ?? null;
}

/**
 * Builds a provider block from a built-in profile preset with an explicit API
 * key — used by UI callers to probe a connection before saving anything.
 */
export function providerConfigFromProfile(
  profileId: Exclude<ProviderProfileId, "custom">,
  apiKey: string,
): ProviderConfig {
  const preset = getProviderProfile(profileId)!;
  return { profile: preset.id, baseUrl: preset.baseUrl, apiKey, model: preset.model };
}

/** Trims a base URL and strips trailing slashes so path joins never double up. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Joins a provider base URL with an endpoint path.
 *
 * @example
 * joinProviderUrl("http://127.0.0.1:8394/v1", "/chat/completions");
 * // "http://127.0.0.1:8394/v1/chat/completions"
 */
export function joinProviderUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

function defaultProviderConfig(role: ProviderRole): ProviderConfig {
  const profile = getProviderProfile(DEFAULT_ROLE_PROFILE[role])!;
  return { profile: profile.id, baseUrl: profile.baseUrl, apiKey: "", model: profile.model };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalizes a raw stored provider block, falling back to the role defaults
 * for missing or invalid fields.
 */
export function normalizeProviderConfig(role: ProviderRole, raw: unknown): ProviderConfig {
  const fallback = defaultProviderConfig(role);
  const candidate = (raw ?? {}) as Record<string, unknown>;

  const profileId = asNonEmptyString(candidate.profile);
  const profile = profileId ? getProviderProfile(profileId) : null;
  const resolvedProfile: ProviderProfileId = profile
    ? profile.id
    : profileId === "custom"
      ? "custom"
      : fallback.profile;

  return {
    profile: resolvedProfile,
    baseUrl: normalizeBaseUrl(asNonEmptyString(candidate.baseUrl) ?? fallback.baseUrl),
    apiKey: asNonEmptyString(candidate.apiKey) ?? "",
    model: asNonEmptyString(candidate.model) ?? fallback.model,
  };
}

/** Reads and normalizes the provider block for a role. */
export async function getProviderConfig(
  role: ProviderRole,
  storage?: ProviderStorageArea,
): Promise<ProviderConfig> {
  const area = storage ?? chrome.storage.local;
  const result = await area.get(storageKeyFor(role));
  return normalizeProviderConfig(role, result[storageKeyFor(role)]);
}

/** Persists the provider block for a role. */
export async function saveProviderConfig(
  role: ProviderRole,
  config: ProviderConfig,
  storage?: ProviderStorageArea,
): Promise<void> {
  const area = storage ?? chrome.storage.local;
  await area.set({ [storageKeyFor(role)]: normalizeProviderConfig(role, config) });
}

/**
 * Resolves the API key for a provider block.
 *
 * A block-level key always wins. As a legacy migration path, the OpenAI
 * profile falls back to the encrypted vault key saved before the
 * provider-agnostic settings existed — so users who already stored an OpenAI
 * key keep working without re-entering it.
 */
export async function resolveProviderApiKey(config: ProviderConfig): Promise<string | null> {
  if (config.apiKey) return config.apiKey;
  if (config.profile === "openai") return getOpenAiApiKey();
  return null;
}

function legacyChatModel(stored: Record<string, unknown>): string | null {
  const settings = stored.settings;
  if (!settings || typeof settings !== "object") return null;
  return asNonEmptyString((settings as Record<string, unknown>).aiModel);
}

/**
 * One-time migration from the previous OpenAI-only setup.
 *
 * If a legacy OpenAI credential exists in storage and no provider blocks were
 * saved yet, both roles are pointed at the OpenAI profile with an empty
 * block-level key. Key resolution then transparently uses the existing vault
 * credential, so users with a saved key see no behavior change. When neither
 * provider blocks nor a legacy credential exist, the defaults
 * (Local Whisper + Z.ai GLM) apply and nothing is written.
 *
 * Idempotent: provider blocks already present short-circuit the migration.
 */
export async function migrateProviderSettings(
  storage?: ProviderStorageArea,
): Promise<{ migrated: boolean }> {
  const area = storage ?? chrome.storage.local;
  const stored = await area.get([
    storageKeyFor("transcription"),
    storageKeyFor("summary"),
    "openai_api_key",
    "settings",
  ]);

  if (stored[storageKeyFor("transcription")] || stored[storageKeyFor("summary")]) {
    return { migrated: false };
  }

  if (!asNonEmptyString(stored.openai_api_key)) {
    return { migrated: false };
  }

  const openaiProfile = getProviderProfile("openai")!;
  const model = legacyChatModel(stored) ?? openaiProfile.model;

  await area.set({
    [storageKeyFor("transcription")]: {
      profile: openaiProfile.id,
      baseUrl: openaiProfile.baseUrl,
      apiKey: "",
      model: openaiProfile.model,
    },
    [storageKeyFor("summary")]: {
      profile: openaiProfile.id,
      baseUrl: openaiProfile.baseUrl,
      apiKey: "",
      model,
    },
  });

  return { migrated: true };
}
