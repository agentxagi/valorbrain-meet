/**
 * @fileoverview Why the microphone did not join a recording, in PT-BR.
 *
 * Chrome raises NotAllowedError in two different situations: the extension's
 * own Chrome permission is missing ("Permission denied"), or the operating
 * system blocks Chrome itself ("Permission denied by system": macOS Privacy &
 * Security, Windows privacy settings). The fixes live in different places, so
 * the second case is reported as {@link SYSTEM_DENIED}.
 */

/** Error code for a microphone blocked by the operating system, not by Chrome. */
export const SYSTEM_DENIED = "SystemDenied";

/** Stable code for a getUserMedia failure: the DOMException name or SYSTEM_DENIED. */
export function microphoneErrorCode(err: unknown): string {
  const e = (err ?? {}) as { name?: unknown; message?: unknown };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const message = typeof e.message === "string" ? e.message : "";
  if (name === "NotAllowedError" && /by system/i.test(message)) return SYSTEM_DENIED;
  return name;
}

/** Where to let Chrome use the microphone, per `chrome.runtime.PlatformOs`. */
export function systemMicrophoneHelp(os: string | null | undefined): string {
  if (os === "mac") {
    return "O macOS está bloqueando o microfone para o Chrome. Abra Ajustes do Sistema → Privacidade e Segurança → Microfone e ative o Google Chrome.";
  }
  if (os === "win") {
    return "O Windows está bloqueando o microfone para o Chrome. Abra Configurações → Privacidade e segurança → Microfone e permita o acesso dos aplicativos da área de trabalho.";
  }
  return "O sistema está bloqueando o microfone para o Chrome. Libere o Chrome nas configurações de privacidade do sistema.";
}

/** `chrome.runtime.getPlatformInfo().os` ("mac", "win", …), or "" when unavailable. */
export async function platformOs(): Promise<string> {
  try {
    const info = await globalThis.chrome?.runtime?.getPlatformInfo?.();
    return info?.os ?? "";
  } catch {
    return "";
  }
}

const TAIL = " A gravação segue só com o áudio da reunião, sem a sua voz.";

/** Explains why the microphone is not part of the recording. */
export function microphoneNotice(requested: boolean, code: unknown, os?: string | null): string {
  if (code === SYSTEM_DENIED) {
    return `${systemMicrophoneHelp(os)} Depois, reinicie a gravação.${TAIL}`;
  }
  if (!requested || code === "NotAllowedError" || code === "SecurityError") {
    return `O microfone ainda não foi liberado para o ValorBrain Meet. Libere em Configurações → Microfone e reinicie a gravação.${TAIL}`;
  }
  if (code === "NotFoundError" || code === "OverconstrainedError") {
    return `Nenhum microfone foi encontrado neste computador.${TAIL}`;
  }
  if (code === "NotReadableError" || code === "AbortError") {
    return `O microfone está ocupado ou falhou ao abrir. Feche outros apps que o usam e reinicie a gravação.${TAIL}`;
  }
  return `Seu microfone não entrou na gravação.${TAIL}`;
}
