import { participantNameFromCandidate } from "./participantDetection";
import { namesMatch } from "./utils/nameUtils";

/** Label used when Meet did not reveal who was speaking. */
export const DEFAULT_TRANSCRIPT_SPEAKER = "Participante";

/** Label for the microphone when the recording user's name is unknown. */
export const SELF_SPEAKER_FALLBACK = "Você";

export function normalizeActiveSpeakerName(value: unknown): string | null {
  return participantNameFromCandidate({
    text: typeof value === "string" ? value : "",
  });
}

export function resolveTranscriptSpeaker(value: string | null | undefined): string {
  return normalizeActiveSpeakerName(value) || DEFAULT_TRANSCRIPT_SPEAKER;
}

export function debounceSpeakerAttribution<T extends (...args: unknown[]) => void>(
  callback: T,
  delay: number,
): { invoke: (...args: Parameters<T>) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const invoke = (...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      callback(...args);
    }, delay);
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { invoke, cancel };
}

/** "Meet says X started speaking at `at`" (ms epoch). */
export interface SpeakerEvent {
  name: string;
  at: number;
}

/**
 * Who spoke the most during [start, end], from Meet's active-speaker changes.
 * Each event lasts until the next one. Names matching `exclude` (the recording
 * user, whose voice is on the microphone channel) never win.
 */
export function dominantSpeaker(
  events: SpeakerEvent[],
  start: number,
  end: number,
  exclude: (name: string) => boolean = () => false,
): string | null {
  if (!(end > start) || events.length === 0) return null;
  const totals = new Map<string, number>();
  for (let i = 0; i < events.length; i += 1) {
    const from = Math.max(events[i].at, start);
    const to = Math.min(i + 1 < events.length ? events[i + 1].at : end, end);
    if (to <= from || exclude(events[i].name)) continue;
    totals.set(events[i].name, (totals.get(events[i].name) ?? 0) + (to - from));
  }
  let best: string | null = null;
  let bestMs = 0;
  for (const [name, ms] of totals) {
    if (ms > bestMs) {
      best = name;
      bestMs = ms;
    }
  }
  return best;
}

export interface TabSpeakerInput {
  events: SpeakerEvent[];
  startedAt: number;
  endedAt: number;
  participants: string[];
  /** Names the recording user may appear under (settings, Meet self tile). */
  selfNames: string[];
  /** Active speaker when the chunk arrived (fallback without events). */
  currentSpeaker: string | null;
}

/**
 * Speaker label for a tab-audio line (someone other than the recording user):
 * the dominant active speaker in the segment; else, in a one-to-one call, the
 * only other participant; else "Participante".
 */
export function resolveTabSpeaker(input: TabSpeakerInput): string {
  const selves = input.selfNames.filter(Boolean);
  const isSelf = (name: string) =>
    name === "You" || name === "Você" || selves.some((self) => namesMatch(name, self));
  const dominant = dominantSpeaker(input.events, input.startedAt, input.endedAt, isSelf);
  if (dominant) return resolveTranscriptSpeaker(dominant);

  const others = input.participants.filter((name) => name && !isSelf(name));
  if (others.length === 1) return resolveTranscriptSpeaker(others[0]);

  if (input.currentSpeaker && !isSelf(input.currentSpeaker) && input.events.length === 0) {
    return resolveTranscriptSpeaker(input.currentSpeaker);
  }
  return DEFAULT_TRANSCRIPT_SPEAKER;
}

function wordSet(text: string): Set<string> {
  return new Set(
    String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3),
  );
}

/**
 * True when a microphone line is the meeting audio leaking into the mic
 * (speakers without headphones): most of its words are in a tab line said at
 * the same time.
 */
export function isEchoOf(micText: string, tabText: string): boolean {
  const mic = wordSet(micText);
  if (mic.size < 4) return false;
  const tab = wordSet(tabText);
  let shared = 0;
  for (const word of mic) if (tab.has(word)) shared += 1;
  return shared / mic.size >= 0.6;
}

/** Two time ranges (ms) overlap, allowing `slackMs` of drift between channels. */
export function rangesOverlap(
  a: { startedAt: number; endedAt: number },
  b: { startedAt: number; endedAt: number },
  slackMs = 3000,
): boolean {
  return a.startedAt <= b.endedAt + slackMs && b.startedAt <= a.endedAt + slackMs;
}
