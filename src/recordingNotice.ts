/**
 * @fileoverview The optional message posted in the meeting chat when a
 * recording starts: everyone in the call learns the meeting is being recorded
 * and transcribed (LGPD transparency), and how (ValorBrain Meet).
 *
 * Off by default: posting in someone else's meeting chat is the user's call.
 * Posted once per meeting, even across stop/start in the same call.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

import type { MeetingPlatform } from "./platforms";

export const DEFAULT_RECORDING_NOTICE =
  "🔴 Esta reunião está sendo gravada e transcrita pelo ValorBrain Meet para registrar o resumo, as decisões e os próximos passos. Se você não quiser que sua fala seja gravada, avise agora. Conheça: https://meet.valorbra.in";

/** Meet caps chat messages at 500 characters. */
export const RECORDING_NOTICE_MAX_CHARS = 500;

/** A second recording in the same call within this window does not post again. */
export const RECORDING_NOTICE_REPEAT_MS = 3 * 60 * 60 * 1000;

/**
 * Waits between tries while the chat is not there yet (lobby, panel loading).
 * Mutable only so tests can shorten it.
 */
export const recordingNoticeTiming = { retryMs: [4_000, 8_000, 15_000] };

const LOG_MAX_ENTRIES = 50;

/** The notice text from the settings: one line, no control characters, capped. */
export function resolveRecordingNoticeText(raw: unknown): string {
  const text = String(typeof raw === "string" ? raw : "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, RECORDING_NOTICE_MAX_CHARS)
    .trim();
  return text || DEFAULT_RECORDING_NOTICE;
}

export function recordingNoticeKey(platform: MeetingPlatform, meetingId: string | null): string {
  return `${platform}:${meetingId || "unknown"}`;
}

export type RecordingNoticeLog = Record<string, number>;

/** Keeps the recent entries only (and a bounded number of them). */
export function pruneRecordingNoticeLog(raw: unknown, now: number): RecordingNoticeLog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]) &&
        now - entry[1] < RECORDING_NOTICE_REPEAT_MS &&
        entry[0] !== "__proto__",
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, LOG_MAX_ENTRIES);
  return Object.fromEntries(entries);
}

export function shouldPostRecordingNotice(
  log: RecordingNoticeLog,
  key: string,
  now: number,
): boolean {
  const last = log[key];
  return typeof last !== "number" || now - last >= RECORDING_NOTICE_REPEAT_MS;
}
