/**
 * @fileoverview Which meeting platform a tab belongs to, and the stable
 * meeting id that identifies the call in its URL.
 *
 * Google Meet is the verified platform. Zoom (web client) and Microsoft Teams
 * (web) are best-effort: their URLs below follow the public join links, and
 * the in-page adapters (platformDom.ts) were written without access to the
 * real call DOM.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

export type MeetingPlatform = "meet" | "zoom" | "teams";

export interface MeetingRef {
  platform: MeetingPlatform;
  meetingId: string;
}

export const PLATFORM_LABELS: Record<MeetingPlatform, string> = {
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
};

/**
 * Match patterns for `chrome.tabs.query`, the same as the manifest's
 * content-script matches (Zoom: the web client only, not the whole site).
 */
export const MEETING_TAB_URLS = [
  "https://meet.google.com/*",
  "https://*.zoom.us/wc/*",
  "https://teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://teams.cloud.microsoft/*",
];

/** Standard Google Meet room: three letters, four letters, three letters. */
const MEET_ID_REGEX = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
/** Zoom meeting numbers have 9 to 11 digits; personal rooms can be longer. */
const ZOOM_ID_REGEX = /^\d{9,13}$/;
/** `19:meeting_<token>@thread.v2`, the Teams meeting thread in join links. */
const TEAMS_THREAD_REGEX = /19:meeting_([A-Za-z0-9_-]{8,})@thread\.v2/;
/** `/meet/<digits>`: Teams meeting-ID links (work and personal accounts). */
const TEAMS_MEET_PATH_REGEX = /^\/meet\/(\d{9,16})(?:\/|$)/;

const TEAMS_HOSTS = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);

function parseUrl(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/** Exact hostnames only: `meet.google.com.evil.com` or `evilzoom.us` never match. */
export function platformForHostname(hostname: string | null | undefined): MeetingPlatform | null {
  const host = String(hostname || "").toLowerCase();
  if (!host) return null;
  if (host === "meet.google.com") return "meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "zoom";
  if (TEAMS_HOSTS.has(host)) return "teams";
  return null;
}

export function platformForUrl(url: string | null | undefined): MeetingPlatform | null {
  const parsed = parseUrl(url);
  return parsed ? platformForHostname(parsed.hostname) : null;
}

function meetId(parsed: URL): string | null {
  const segment = parsed.pathname.split("/").filter(Boolean)[0];
  return segment && MEET_ID_REGEX.test(segment) ? segment : null;
}

/**
 * Zoom web client: `/wc/<number>/join`, `/wc/join/<number>`, `/wc/<number>/start`.
 * Launcher pages (`/j/<number>`, `/s/<number>`) are not the call itself.
 */
function zoomId(parsed: URL): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "wc") return null;
  const number = [parts[1], parts[2]].find((part) => part && ZOOM_ID_REGEX.test(part));
  return number ? `zoom-${number}` : null;
}

/**
 * Teams: the meeting thread id from a join link (it survives in the hash of
 * the web client: `/v2/?meetingjoin=true#/l/meetup-join/19:meeting_…`), or the
 * numeric meeting id of `/meet/<digits>` links.
 */
function teamsId(parsed: URL): string | null {
  const numeric = TEAMS_MEET_PATH_REGEX.exec(parsed.pathname)?.[1];
  if (numeric) return `teams-${numeric}`;
  let decoded = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* malformed escapes: match on the raw string */
  }
  const token = TEAMS_THREAD_REGEX.exec(decoded)?.[1];
  return token ? `teams-${token.slice(0, 16).toLowerCase()}` : null;
}

/** The platform and meeting id of a call URL, or null when it is not a call. */
export function meetingRefFromUrl(url: string | null | undefined): MeetingRef | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const platform = platformForHostname(parsed.hostname);
  if (!platform) return null;
  const meetingId =
    platform === "meet" ? meetId(parsed) : platform === "zoom" ? zoomId(parsed) : teamsId(parsed);
  return meetingId ? { platform, meetingId } : null;
}

/** Human label for a meeting URL ("Zoom"), falling back to "Google Meet". */
export function platformLabelForUrl(url: string | null | undefined): string {
  return PLATFORM_LABELS[platformForUrl(url) ?? "meet"];
}

/**
 * Whether the recorded tab navigating to `nextUrl` means the user left the
 * call.
 *
 * - Meet and Zoom keep the meeting id in the URL for the whole call: another
 *   id (or none) means the call is over.
 * - Teams drops the id once the call starts, so a URL without one proves
 *   nothing: leaving Teams, or a URL carrying another meeting's id, does.
 *   Hanging up is caught in the page (the call controls disappear).
 * - A recording that did not start on a call URL (a webinar, a replay, any
 *   tab from the context menu) never stops on navigation.
 */
export function navigatedAwayFromCall(
  meetingUrl: string | null | undefined,
  meetingId: string | null | undefined,
  nextUrl: string,
): boolean {
  const platform = platformForUrl(meetingUrl);
  if (!platform) return false;
  const next = meetingRefFromUrl(nextUrl);
  if (platform === "teams") {
    if (platformForUrl(nextUrl) !== "teams") return true;
    return Boolean(next && meetingId && next.meetingId !== meetingId);
  }
  const current = meetingRefFromUrl(meetingUrl);
  if (!current || current.meetingId !== meetingId) return false;
  return next?.meetingId !== meetingId;
}

/**
 * The meeting id to remember the recording notice by: only an id that comes
 * from the call URL itself (a tab title or "unknown" could repeat across
 * meetings, or change within one).
 */
export function stableMeetingId(
  meetingUrl: string | null | undefined,
  meetingId: string | null | undefined,
): string | null {
  const ref = meetingRefFromUrl(meetingUrl);
  return ref && meetingId && ref.meetingId === meetingId ? ref.meetingId : null;
}
