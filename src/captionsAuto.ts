/**
 * @fileoverview Turning Google Meet's captions (CC) on when the recording
 * starts, so the speaker names they show reach the transcript (meetCaptions.ts).
 *
 * Meet's CC button says what a click would do: "Ativar legendas" / "Turn on
 * captions" / "Activar subtítulos" while captions are off, the "Desativar" /
 * "Turn off" / "Desactivar" form while they are on; its icon ligature is
 * "closed_caption_off" while off. The extension acts only on a state read as
 * "off", and only by clicking, once, a control whose label says it turns
 * captions ON. Meet's "c" shortcut is never used: it is a blind toggle, and
 * with a late redraw (a hidden tab) it would undo a click that worked. An
 * unreadable state is never acted on, so captions are never turned off by
 * mistake; the extension never turns them off at the end either.
 *
 * Pure module (the page is reached through {@link CaptionsEnv}), unit-tested
 * in node.
 */

export type CaptionsState = "on" | "off" | "unknown";

/**
 * How the recording's captions ended up: already on, turned on by the
 * extension, not turned on (the panel asks the user to), or the setting is off.
 */
export type CaptionsStatus = "already-on" | "enabled" | "failed" | "disabled";

const CAPTIONS_STATUSES: Record<CaptionsStatus, true> = {
  "already-on": true,
  enabled: true,
  failed: true,
  disabled: true,
};

/** A status a page (or a stored session) may carry. */
export function isCaptionsStatus(value: unknown): value is CaptionsStatus {
  return typeof value === "string" && Object.hasOwn(CAPTIONS_STATUSES, value);
}

/** What the page shows about one candidate CC control. */
export interface CaptionControlInfo {
  /** aria-label, else data-tooltip. */
  label: string;
  /** aria-pressed. */
  pressed: string | null;
  /** The control's text (Meet's icon ligatures: "closed_caption_off"). */
  text: string;
}

/** Labels of the control while captions are OFF (a click turns them on). */
const TURN_ON_LABEL =
  /^(?:ativar (?:as )?legendas|mostrar (?:as )?legendas|turn on captions|show captions|activar (?:los )?subt[ií]tulos|mostrar (?:los )?subt[ií]tulos)\b/i;
/** Labels of the control while captions are ON (a click would turn them off). */
const TURN_OFF_LABEL =
  /^(?:desativar (?:as )?legendas|ocultar (?:as )?legendas|turn off captions|hide captions|desactivar (?:los )?subt[ií]tulos|ocultar (?:los )?subt[ií]tulos)\b/i;
const CAPTION_WORD = /legenda|caption|subt[ií]tulo/i;

/** The captions state one control shows; "unknown" when it is not the CC toggle. */
export function captionControlState(control: CaptionControlInfo): CaptionsState {
  const label = control.label.replace(/\s+/g, " ").trim();
  if (TURN_OFF_LABEL.test(label)) return "on";
  if (TURN_ON_LABEL.test(label)) return "off";
  const iconOff = /\bclosed_caption_off\b/.test(control.text);
  const iconOn = /\bclosed_caption\b/.test(control.text) && !iconOff;
  if (CAPTION_WORD.test(label) || iconOff || iconOn) {
    if (control.pressed === "true") return "on";
    if (control.pressed === "false") return "off";
    if (iconOff) return "off";
    if (iconOn) return "on";
  }
  return "unknown";
}

/** The first control that reads as the CC toggle, with its state; null when none does. */
export function pickCaptionControl(
  controls: CaptionControlInfo[],
): { index: number; state: Exclude<CaptionsState, "unknown"> } | null {
  for (let index = 0; index < controls.length; index += 1) {
    const state = captionControlState(controls[index]);
    if (state !== "unknown") return { index, state };
  }
  return null;
}

export interface CaptionsEnv {
  /** The setting (Configurações → Recursos), on by default. */
  enabled: boolean;
  /** False once the recording this run belongs to ended: the run stops. */
  active(): boolean;
  /** The state the CC toggle shows now. */
  state(): CaptionsState;
  /** Captions are visibly on: the caption region shows, or a caption turn was read. */
  captionsShowing(): boolean;
  /** Clicks the control that turns captions on; false when there is none. */
  clickTurnOn(): boolean;
  wait(ms: number): Promise<void>;
}

export interface CaptionsTiming {
  /** First waits while the call toolbar loads, until the toggle's state can be read. */
  findDelaysMs: number[];
  /** Then a slow poll for as long as the recording lasts (recording from the lobby). */
  slowPollMs: number;
  /** How long the click has to show an effect. */
  effectWindowMs: number;
  /** How often the effect is checked inside that window. */
  pollMs: number;
}

export const CAPTIONS_TIMING: CaptionsTiming = {
  findDelaysMs: [500, 1000, 2000, 4000],
  slowPollMs: 3000,
  effectWindowMs: 6000,
  pollMs: 500,
};

/**
 * Turns captions on if they are off, and says how it went. Waits, for as long
 * as the recording lasts, until the toggle can be read (a recording started in
 * the lobby has no CC button yet); then, if it reads off, clicks it once and
 * gives the effect (the caption region or the toggle reading on) a window to
 * show. Never a second click, never a key. Captions seen on at any point end it.
 */
export async function ensureCaptionsOn(
  env: CaptionsEnv,
  timing: CaptionsTiming = CAPTIONS_TIMING,
): Promise<CaptionsStatus> {
  if (!env.enabled) return "disabled";
  const isOn = () => env.captionsShowing() || env.state() === "on";
  const read = (): CaptionsState => (isOn() ? "on" : env.state());

  let state = read();
  for (let attempt = 0; state === "unknown"; attempt += 1) {
    if (!env.active()) return "failed";
    await env.wait(timing.findDelaysMs[attempt] ?? timing.slowPollMs);
    state = read();
  }
  if (state === "on") return "already-on";

  if (!env.active() || !env.clickTurnOn()) return isOn() ? "already-on" : "failed";
  for (let waited = 0; waited < timing.effectWindowMs; waited += timing.pollMs) {
    await env.wait(timing.pollMs);
    if (isOn()) return "enabled";
  }
  return "failed";
}

/**
 * The status of the recording, from what each page load reported: once the
 * extension turned captions on, the recording says so whatever comes after
 * (a reload finds them already on).
 */
export function mergeCaptionsStatus(
  previous: CaptionsStatus | undefined,
  next: CaptionsStatus,
): CaptionsStatus {
  return previous === "enabled" ? "enabled" : next;
}

/** The panel's line about captions for the recording ("" when there is nothing to say). */
export function captionsNote(status: CaptionsStatus | undefined): string {
  if (status === "enabled") return "Legendas ligadas pela extensão para identificar quem fala.";
  if (status === "failed") return "Ligue as legendas (CC) para identificar quem fala.";
  return "";
}
