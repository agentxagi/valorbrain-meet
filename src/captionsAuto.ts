/**
 * @fileoverview Turning Google Meet's captions (CC) on when the recording
 * starts, so the speaker names they show reach the transcript (meetCaptions.ts).
 *
 * Meet's CC button says what a click would do: "Ativar legendas" / "Turn on
 * captions" / "Activar subtítulos" while captions are off, the "Desativar" /
 * "Turn off" / "Desactivar" form while they are on; its icon ligature is
 * "closed_caption_off" while off. The extension acts only on a state read as
 * "off": it clicks a control whose label says it turns captions ON, and
 * presses Meet's shortcut ("c", a toggle) only when the state reads off and
 * focus is not in a text field. An unreadable state is never acted on, so
 * captions are never turned off by mistake; the extension never turns them
 * off at the end either.
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

/** What the focused element is, for the keyboard fallback. */
export interface FocusInfo {
  tagName: string;
  isContentEditable: boolean;
  role: string | null;
}

/**
 * Whether pressing "c" reaches Meet as its shortcut instead of typing a letter
 * (the chat box, a rename field): nothing editable has the focus.
 */
export function isSafeFocusForShortcut(focus: FocusInfo | null): boolean {
  if (!focus) return true;
  const tag = focus.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (focus.isContentEditable) return false;
  return !/^(textbox|searchbox|combobox)$/i.test(focus.role ?? "");
}

export interface CaptionsEnv {
  /** The setting (Configurações → Recursos), on by default. */
  enabled: boolean;
  /** The state the page shows now. */
  state(): CaptionsState;
  /** Clicks the control that turns captions on; false when there is none. */
  clickTurnOn(): boolean;
  /** Presses Meet's "c" shortcut; false when focus is not safe. */
  pressShortcut(): boolean;
  wait(ms: number): Promise<void>;
}

/** Waits between checks: the toolbar may still be loading, and Meet updates the button late. */
export const CAPTIONS_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
/** Clicks before the keyboard fallback is tried instead. */
const CLICKS_BEFORE_SHORTCUT = 2;

/**
 * Turns captions on if they are off, and says how it went. Acts only on a
 * state read as "off", and after each action only observes for one round
 * (Meet may update the button late: acting again on a stale "off" would turn
 * them off). Never acts on an unknown state.
 */
export async function ensureCaptionsOn(
  env: CaptionsEnv,
  delays: number[] = CAPTIONS_RETRY_DELAYS_MS,
): Promise<CaptionsStatus> {
  if (!env.enabled) return "disabled";
  let acted = false;
  let justActed = false;
  let clicks = 0;
  for (const delay of delays) {
    const state = env.state();
    if (state === "on") return acted ? "enabled" : "already-on";
    if (justActed) {
      justActed = false;
    } else if (state === "off") {
      const clicked = clicks < CLICKS_BEFORE_SHORTCUT && env.clickTurnOn();
      if (clicked) clicks += 1;
      justActed = clicked || env.pressShortcut();
      acted ||= justActed;
    }
    await env.wait(delay);
  }
  if (env.state() === "on") return acted ? "enabled" : "already-on";
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
