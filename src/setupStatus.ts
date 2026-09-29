/**
 * @fileoverview "Is this ready for a meeting?" checklist shared by the popup
 * and the options page. Reads the saved configuration (never guesses) and
 * optionally probes a local Whisper server.
 */

import {
  getProviderConfig,
  getProviderProfile,
  requiresApiKey,
  resolveProviderApiKey,
  type ProviderConfig,
} from "./utils/providerSettings";
import { getVbSettings, isVbConfigured, resolveAutoSend } from "./vbClient";
import { hostOf } from "./ui/format";

export type SetupState = "ok" | "warning" | "missing" | "checking";
export type SetupItemId = "transcription" | "summary" | "valorbrain" | "microphone";

export interface SetupItem {
  id: SetupItemId;
  state: SetupState;
  title: string;
  detail: string;
  /** Options page anchor that fixes this item. */
  anchor: string;
}

export type MicPermission = "granted" | "prompt" | "denied" | "unknown";

/** Microphone permission of the extension origin (shared by popup/offscreen). */
export async function getMicPermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state as MicPermission;
  } catch {
    return "unknown";
  }
}

function providerLabel(config: ProviderConfig): string {
  if (config.profile === "custom") return `Personalizado (${hostOf(config.baseUrl)})`;
  return getProviderProfile(config.profile)?.label ?? config.profile;
}

/** Origin of the local Whisper health route (`http://127.0.0.1:8394/health`). */
function healthUrlFor(config: ProviderConfig): string | null {
  if (config.profile !== "whisper-local") return null;
  try {
    return `${new URL(config.baseUrl).origin}/health`;
  } catch {
    return null;
  }
}

/**
 * Probes the local Whisper server. Two short attempts: the systemd socket
 * starts the server on the first connection, which may be refused once.
 */
export async function probeLocalWhisper(config: ProviderConfig): Promise<boolean | null> {
  const url = healthUrlFor(config);
  if (!url) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return true;
    } catch {
      /* retry once */
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  return false;
}

async function transcriptionItem(probe: boolean): Promise<SetupItem> {
  const config = await getProviderConfig("transcription");
  const key = await resolveProviderApiKey(config);
  const base = { id: "transcription" as const, title: "Transcrição", anchor: "transcricao" };
  if (requiresApiKey(config) && !key) {
    return { ...base, state: "missing", detail: `${providerLabel(config)}: falta a chave de API` };
  }
  if (probe && config.profile === "whisper-local") {
    const online = await probeLocalWhisper(config);
    if (online === false) {
      return {
        ...base,
        state: "warning",
        // Typical cause: the server runs on another machine or inside WSL,
        // which the browser cannot reach through 127.0.0.1.
        detail: `Whisper local não respondeu em ${hostOf(config.baseUrl)}. Se ele roda em outro computador ou no WSL, escolha "Whisper remoto".`,
      };
    }
  }
  return { ...base, state: "ok", detail: providerLabel(config) };
}

async function summaryItem(): Promise<SetupItem> {
  const config = await getProviderConfig("summary");
  const key = await resolveProviderApiKey(config);
  const base = { id: "summary" as const, title: "Resumo com IA", anchor: "resumo" };
  if (requiresApiKey(config) && !key) {
    return {
      ...base,
      state: "missing",
      detail: `${providerLabel(config)}: falta a chave de API. Sem ela, só a transcrição funciona.`,
    };
  }
  return { ...base, state: "ok", detail: `${providerLabel(config)} · ${config.model}` };
}

async function valorBrainItem(): Promise<SetupItem> {
  const settings = await getVbSettings();
  const base = { id: "valorbrain" as const, title: "ValorBrain", anchor: "valorbrain" };
  if (!isVbConfigured(settings)) {
    return {
      ...base,
      state: "missing",
      detail: "Não conectado. As reuniões ficam só neste navegador.",
    };
  }
  if (!resolveAutoSend(settings)) {
    return {
      ...base,
      state: "warning",
      detail: `Conectado a ${hostOf(settings.baseUrl)}, com envio automático desligado`,
    };
  }
  return { ...base, state: "ok", detail: `Conectado a ${hostOf(settings.baseUrl)}` };
}

function microphoneItem(permission: MicPermission): SetupItem {
  const base = { id: "microphone" as const, title: "Microfone", anchor: "microfone" };
  if (permission === "granted")
    return { ...base, state: "ok", detail: "Liberado: sua voz entra na gravação" };
  if (permission === "denied") {
    return { ...base, state: "missing", detail: "Bloqueado no Chrome: sua voz não será gravada" };
  }
  return { ...base, state: "warning", detail: "Ainda não liberado: sua voz não será gravada" };
}

/** Builds the full checklist. `probe` also pings a local Whisper server. */
export async function getSetupStatus(options: { probe?: boolean } = {}): Promise<SetupItem[]> {
  const [transcription, summary, valorbrain, mic] = await Promise.all([
    transcriptionItem(options.probe === true),
    summaryItem(),
    valorBrainItem(),
    getMicPermission(),
  ]);
  return [transcription, summary, microphoneItem(mic), valorbrain];
}

/** True when nothing blocks recording a meeting with summary + delivery. */
export function isSetupComplete(items: SetupItem[]): boolean {
  return items.every((item) => item.state === "ok");
}
