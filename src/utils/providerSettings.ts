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
export type ProviderProfileId =
  | "whisper-local"
  | "whisper-valor"
  | "zai-coding"
  | "zai"
  | "openai"
  | "custom";

/** A ready-made provider preset offered in the options dropdown. */
export interface ProviderProfile {
  id: Exclude<ProviderProfileId, "custom">;
  label: string;
  /** One-line PT-BR explanation shown under the dropdown. */
  description: string;
  /** Pipeline stages this preset can drive. */
  roles: ProviderRole[];
  baseUrl: string;
  /** Default model for the preset's first role. */
  model: string;
  /** Per-role default model when the preset serves both roles. */
  models?: Partial<Record<ProviderRole, string>>;
  /** Whether requests without an API key are pointless (cloud endpoints). */
  requiresKey: boolean;
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
    label: "Whisper local (neste computador)",
    description: "Servidor faster-whisper em 127.0.0.1:8394. O áudio não sai da máquina.",
    roles: ["transcription"],
    baseUrl: "http://127.0.0.1:8394/v1",
    model: "whisper-local",
    requiresKey: false,
  },
  {
    id: "whisper-valor",
    label: "Whisper remoto (whisper.valor.digital)",
    description: "O mesmo Whisper, publicado com túnel. Exige a chave Bearer do servidor.",
    roles: ["transcription"],
    baseUrl: "https://whisper.valor.digital/v1",
    model: "whisper-local",
    requiresKey: true,
  },
  {
    id: "zai-coding",
    label: "Z.ai GLM (GLM Coding Plan)",
    description: "Para chaves do GLM Coding Plan. Endpoint /api/coding/paas/v4.",
    roles: ["summary"],
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    model: "glm-5.3-flash",
    requiresKey: true,
  },
  {
    id: "zai",
    label: "Z.ai GLM (API pré-paga)",
    description: "Para chaves com saldo na API padrão da Z.ai. Endpoint /api/paas/v4.",
    roles: ["summary"],
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-5.3-flash",
    requiresKey: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "API oficial da OpenAI. Transcrição com whisper-1, resumo com gpt-4o-mini.",
    roles: ["transcription", "summary"],
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    models: { transcription: "whisper-1", summary: "gpt-4o-mini" },
    requiresKey: true,
  },
];

/** Profile used when a role has no stored configuration yet. */
export const DEFAULT_ROLE_PROFILE: Record<ProviderRole, Exclude<ProviderProfileId, "custom">> = {
  transcription: "whisper-local",
  summary: "zai-coding",
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

/** Built-in profiles that can drive `role`, in display order. */
export function profilesForRole(role: ProviderRole): ProviderProfile[] {
  return PROVIDER_PROFILES.filter((profile) => profile.roles.includes(role));
}

/** Default model of `profile` for `role`. */
export function profileModel(profile: ProviderProfile, role: ProviderRole): string {
  return profile.models?.[role] ?? profile.model;
}

/**
 * Builds a provider block from a built-in profile preset with an explicit API
 * key — used by UI callers to probe a connection before saving anything.
 */
export function providerConfigFromProfile(
  profileId: Exclude<ProviderProfileId, "custom">,
  apiKey: string,
  role: ProviderRole = "summary",
): ProviderConfig {
  const preset = getProviderProfile(profileId)!;
  return {
    profile: preset.id,
    baseUrl: preset.baseUrl,
    apiKey,
    model: profileModel(preset, role),
  };
}

/**
 * Whether the block is useless without an API key. Built-in cloud presets
 * always need one; local and custom endpoints may run without auth.
 */
export function requiresApiKey(config: Pick<ProviderConfig, "profile">): boolean {
  return getProviderProfile(config.profile)?.requiresKey ?? false;
}

/** True when the block targets one of the Z.ai GLM endpoints. */
export function isZaiProvider(config: Pick<ProviderConfig, "profile" | "baseUrl">): boolean {
  if (config.profile === "zai" || config.profile === "zai-coding") return true;
  try {
    return /(^|\.)z\.ai$|(^|\.)bigmodel\.cn$/.test(new URL(config.baseUrl).hostname);
  } catch {
    return false;
  }
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

/** Default block for a role (its default profile, empty key). */
export function defaultProviderConfig(role: ProviderRole): ProviderConfig {
  const profile = getProviderProfile(DEFAULT_ROLE_PROFILE[role])!;
  return {
    profile: profile.id,
    baseUrl: profile.baseUrl,
    apiKey: "",
    model: profileModel(profile, role),
  };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalizes a raw stored provider block, falling back to the role defaults
 * for missing or invalid fields. A preset stored for a role it cannot drive
 * (e.g. a chat preset under transcription) is kept as `custom` so the user's
 * hand-typed URL/model survive.
 */
export function normalizeProviderConfig(role: ProviderRole, raw: unknown): ProviderConfig {
  const fallback = defaultProviderConfig(role);
  const candidate = (raw ?? {}) as Record<string, unknown>;

  const profileId = asNonEmptyString(candidate.profile);
  const profile = profileId ? getProviderProfile(profileId) : null;

  let resolvedProfile: ProviderProfileId;
  if (profile) {
    resolvedProfile = profile.roles.includes(role) ? profile.id : "custom";
  } else {
    resolvedProfile = profileId === "custom" ? "custom" : fallback.profile;
  }

  const presetForDefaults =
    resolvedProfile === "custom" ? null : getProviderProfile(resolvedProfile);

  return {
    profile: resolvedProfile,
    baseUrl: normalizeBaseUrl(
      asNonEmptyString(candidate.baseUrl) ?? presetForDefaults?.baseUrl ?? fallback.baseUrl,
    ),
    apiKey: asNonEmptyString(candidate.apiKey) ?? "",
    model:
      asNonEmptyString(candidate.model) ??
      (presetForDefaults ? profileModel(presetForDefaults, role) : fallback.model),
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

/** True when the user saved a block for this role at least once. */
export async function hasSavedProviderConfig(
  role: ProviderRole,
  storage?: ProviderStorageArea,
): Promise<boolean> {
  const area = storage ?? chrome.storage.local;
  const result = await area.get(storageKeyFor(role));
  return Boolean(result[storageKeyFor(role)]);
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
 * block-level key (transcription on `whisper-1`, summaries on the legacy chat
 * model). Key resolution then transparently uses the existing vault
 * credential. When neither provider blocks nor a legacy credential exist, the
 * defaults apply and nothing is written.
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
  const model = legacyChatModel(stored) ?? profileModel(openaiProfile, "summary");

  await area.set({
    [storageKeyFor("transcription")]: {
      profile: openaiProfile.id,
      baseUrl: openaiProfile.baseUrl,
      apiKey: "",
      model: profileModel(openaiProfile, "transcription"),
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
