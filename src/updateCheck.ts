/**
 * @fileoverview Tells people on an old version that a newer one exists.
 *
 * The extension is installed from the zip on meet.valorbra.in ("Carregar sem
 * compactação"), and Chrome never updates such an extension. Once a day the
 * service worker reads the site's static latest.json (scripts/buildSite.ts)
 * with a plain GET: no query string, no cookies, no custom headers, nothing
 * about meetings. The site sees what any visit shows (IP, user agent).
 * Settings → Atualizações turns it off.
 *
 * Pure except for `fetch` (injectable): unit-tested in node.
 */

export const LATEST_MANIFEST_URL = "https://meet.valorbra.in/latest.json";
/** The site's update instructions (site.js opens them on this hash). */
export const UPDATE_PAGE_URL = "https://meet.valorbra.in/#atualizar";
/** chrome.storage.local key holding the last check's result. */
export const UPDATE_STATUS_KEY = "updateStatus";
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/** A successful check holds for a day; a failed one is retried sooner. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_RETRY_INTERVAL_MS = 3 * 60 * 60 * 1000;

const DOWNLOAD_URL_PREFIX = "https://meet.valorbra.in/downloads/";
const NOTES_URL_PREFIX = "https://github.com/agentxagi/valorbrain-meet/";

/** What latest.json announces, once validated. */
export interface LatestRelease {
  version: string;
  url: string;
  notes?: string;
  sha256?: string;
}

/** The last check, stored under {@link UPDATE_STATUS_KEY}. */
export interface UpdateStatus {
  checkedAt: number;
  /** The request worked (a failed one is retried after 3 h). */
  ok: boolean;
  latestVersion?: string;
  notesUrl?: string;
  /** The site offers a version newer than the installed one. */
  available: boolean;
  error?: string;
}

/** "v2.10.0" → [2, 10, 0]; null for anything that is not a dotted number. */
function versionParts(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().replace(/^v/i, "").split(".");
  if (parts.length > 4 || !parts.every((part) => /^\d{1,9}$/.test(part))) return null;
  return parts.map(Number);
}

/**
 * Orders dotted numeric versions ("2.10.0" is newer than "2.9.9"; a leading
 * "v" is fine): positive when `a` is newer, negative when older, 0 when equal
 * or when either is not a version, which is never newer.
 */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Validates latest.json: a plain x.y.z version and a download on the site
 * itself, or null. Release notes are kept only from the project's repository
 * and the checksum only when it is one; anything else is dropped.
 */
export function parseLatestRelease(raw: unknown): LatestRelease | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { version, url, notes, sha256 } = raw as Record<string, unknown>;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (typeof url !== "string" || !url.startsWith(DOWNLOAD_URL_PREFIX)) return null;
  return {
    version,
    url,
    ...(typeof notes === "string" && notes.startsWith(NOTES_URL_PREFIX) ? { notes } : {}),
    ...(typeof sha256 === "string" && /^[0-9a-f]{64}$/i.test(sha256) ? { sha256 } : {}),
  };
}

/** Due when never checked, a day after a successful check, 3 h after a failed one. */
export function isCheckDue(status: UpdateStatus | null | undefined, now: number): boolean {
  const checkedAt = Number(status?.checkedAt);
  // A clock set back would otherwise silence the check until it catches up.
  if (!status || !Number.isFinite(checkedAt) || checkedAt > now) return true;
  const interval = status.ok === true ? UPDATE_CHECK_INTERVAL_MS : UPDATE_RETRY_INTERVAL_MS;
  return now - checkedAt >= interval;
}

export interface UpdateCheckOptions {
  /** The installed version (chrome.runtime.getManifest().version). */
  currentVersion: string;
  now?: number;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The last stored result: a failed check keeps the newer version it knew. */
  previous?: UpdateStatus | null;
}

function failedCheck(options: UpdateCheckOptions, now: number, error: string): UpdateStatus {
  // A network blip must not hide an update an earlier check already found.
  const known = options.previous?.latestVersion;
  const notesUrl = options.previous?.notesUrl;
  return {
    checkedAt: now,
    ok: false,
    ...(typeof known === "string" ? { latestVersion: known } : {}),
    ...(typeof known === "string" && typeof notesUrl === "string" ? { notesUrl } : {}),
    available: typeof known === "string" && compareVersions(known, options.currentVersion) > 0,
    error,
  };
}

/**
 * Reads latest.json once, with a 10 s limit, and compares it with the
 * installed version. Never throws: a failure is a status with `ok: false`.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateStatus> {
  const now = options.now ?? Date.now();
  // Called unbound: Chrome's fetch refuses any other `this`.
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await doFetch(LATEST_MANIFEST_URL, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) return failedCheck(options, now, `HTTP ${response.status}`);
    const release = parseLatestRelease(await response.json());
    if (!release) return failedCheck(options, now, "latest.json inválido");
    return {
      checkedAt: now,
      ok: true,
      latestVersion: release.version,
      ...(release.notes ? { notesUrl: release.notes } : {}),
      available: compareVersions(release.version, options.currentVersion) > 0,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return failedCheck(options, now, timedOut ? "tempo esgotado" : String(err));
  } finally {
    clearTimeout(timer);
  }
}
