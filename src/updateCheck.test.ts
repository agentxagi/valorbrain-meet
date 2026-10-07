import test from "node:test";
import assert from "node:assert/strict";

import {
  checkForUpdate,
  compareVersions,
  isCheckDue,
  LATEST_MANIFEST_URL,
  parseLatestRelease,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_PAGE_URL,
  UPDATE_RETRY_INTERVAL_MS,
  type UpdateStatus,
} from "./updateCheck.ts";

const SHA = "a".repeat(64);

/** latest.json as scripts/buildSite.ts writes it. */
function latestJson(version = "2.5.0") {
  return {
    version,
    file: `valorbrain-meet-v${version}.zip`,
    url: `https://meet.valorbra.in/downloads/valorbrain-meet-v${version}.zip`,
    sha256: SHA,
    size: 199360,
    released: "2026-10-01T12:00:00.000Z",
    notes: `https://github.com/agentxagi/valorbrain-meet/releases/tag/v${version}`,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("versions compare as numbers, not text", () => {
  assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
  assert.equal(compareVersions("2.3.0", "2.4.0"), -1);
  assert.equal(compareVersions("2.4.0", "2.4.0"), 0);
  assert.equal(compareVersions("v2.4.1", "2.4.0"), 1, "a leading v is fine");
  assert.equal(compareVersions("2.4", "2.4.0"), 0);
});

test("anything that is not a version is never newer", () => {
  assert.equal(compareVersions("2.5.0-beta", "2.4.0"), 0);
  assert.equal(compareVersions("latest", "2.4.0"), 0);
  assert.equal(compareVersions("", "2.4.0"), 0);
  assert.equal(compareVersions("3.0.0", "dev"), 0);
});

test("latest.json from the site is read as published", () => {
  assert.deepEqual(parseLatestRelease(latestJson()), {
    version: "2.5.0",
    url: "https://meet.valorbra.in/downloads/valorbrain-meet-v2.5.0.zip",
    notes: "https://github.com/agentxagi/valorbrain-meet/releases/tag/v2.5.0",
    sha256: SHA,
  });
});

test("a release with an odd version or a download elsewhere is refused", () => {
  for (const version of ["v2.5.0", "2.5", "2.5.0-beta", "2.5.0.1"]) {
    assert.equal(parseLatestRelease({ ...latestJson(), version }), null, version);
  }
  assert.equal(parseLatestRelease({ ...latestJson(), version: 250 }), null);
  for (const url of [
    "https://evil.example/downloads/valorbrain-meet-v2.5.0.zip",
    "http://meet.valorbra.in/downloads/valorbrain-meet-v2.5.0.zip",
    "https://meet.valorbra.in.evil.example/downloads/x.zip",
    "https://meet.valorbra.in/outra/x.zip",
  ]) {
    assert.equal(parseLatestRelease({ ...latestJson(), url }), null, url);
  }
  for (const raw of [null, "2.5.0", [latestJson()], 42]) {
    assert.equal(parseLatestRelease(raw), null);
  }
});

test("notes from another place and a malformed checksum are dropped", () => {
  const release = parseLatestRelease({
    ...latestJson(),
    notes: "https://example.com/agentxagi/valorbrain-meet/",
    sha256: "not-a-hash",
  });
  assert.deepEqual(release, {
    version: "2.5.0",
    url: "https://meet.valorbra.in/downloads/valorbrain-meet-v2.5.0.zip",
  });
});

test("a check is due when never made, a day after success, 3 hours after a failure", () => {
  const now = 1_000_000_000_000;
  const done = (ok: boolean, ago: number): UpdateStatus => ({
    checkedAt: now - ago,
    ok,
    available: false,
  });
  assert.equal(isCheckDue(null, now), true);
  assert.equal(isCheckDue(undefined, now), true);
  assert.equal(isCheckDue(done(true, UPDATE_CHECK_INTERVAL_MS - 60_000), now), false);
  assert.equal(isCheckDue(done(true, UPDATE_CHECK_INTERVAL_MS), now), true);
  assert.equal(isCheckDue(done(false, UPDATE_RETRY_INTERVAL_MS - 60_000), now), false);
  assert.equal(isCheckDue(done(false, UPDATE_RETRY_INTERVAL_MS), now), true);
  assert.equal(isCheckDue(done(true, -60_000), now), true, "clock set back");
  assert.equal(isCheckDue({ checkedAt: "ontem" } as unknown as UpdateStatus, now), true);
});

test("the check is a plain GET of the static file: no query, cookies or headers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const status = await checkForUpdate({
    currentVersion: "2.4.0",
    now: 1234,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, latestJson("2.5.0"));
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LATEST_MANIFEST_URL);
  assert.equal(calls[0].url, "https://meet.valorbra.in/latest.json");
  const { signal, ...init } = calls[0].init;
  assert.ok(signal, "the request can be timed out");
  assert.deepEqual(init, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  assert.deepEqual(status, {
    checkedAt: 1234,
    ok: true,
    latestVersion: "2.5.0",
    notesUrl: "https://github.com/agentxagi/valorbrain-meet/releases/tag/v2.5.0",
    available: true,
  });
  assert.equal(UPDATE_PAGE_URL, "https://meet.valorbra.in/#atualizar");
});

test("the same or an older version on the site is not an update", async () => {
  for (const [site, installed] of [
    ["2.4.0", "2.4.0"],
    ["2.4.0", "2.10.0"],
  ]) {
    const status = await checkForUpdate({
      currentVersion: installed,
      now: 1,
      fetchImpl: async () => jsonResponse(200, latestJson(site)),
    });
    assert.equal(status.ok, true);
    assert.equal(status.available, false, `${site} vs ${installed}`);
  }
});

test("failures never throw and are reported as a failed check", async () => {
  const outcomes = [
    await checkForUpdate({
      currentVersion: "2.4.0",
      fetchImpl: async () => jsonResponse(404, { error: "not found" }),
    }),
    await checkForUpdate({
      currentVersion: "2.4.0",
      fetchImpl: async () => new Response("<html>oops</html>", { status: 200 }),
    }),
    await checkForUpdate({
      currentVersion: "2.4.0",
      fetchImpl: async () => jsonResponse(200, { ...latestJson(), url: "https://evil.example/x" }),
    }),
    await checkForUpdate({
      currentVersion: "2.4.0",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }),
  ];
  for (const status of outcomes) {
    assert.equal(status.ok, false);
    assert.equal(status.available, false);
    assert.equal(typeof status.error, "string");
  }
  assert.equal(outcomes[0].error, "HTTP 404");
});

test("a site that does not answer gives up after the timeout", async () => {
  const status = await checkForUpdate({
    currentVersion: "2.4.0",
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  });
  assert.equal(status.ok, false);
  assert.equal(status.error, "tempo esgotado");
});

test("a failed check keeps an update an earlier check found", async () => {
  const previous: UpdateStatus = {
    checkedAt: 1,
    ok: true,
    latestVersion: "2.5.0",
    notesUrl: "https://github.com/agentxagi/valorbrain-meet/releases/tag/v2.5.0",
    available: true,
  };
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  const stillOld = await checkForUpdate({
    currentVersion: "2.4.0",
    now: 2,
    previous,
    fetchImpl: offline,
  });
  assert.equal(stillOld.ok, false);
  assert.equal(stillOld.checkedAt, 2);
  assert.equal(stillOld.latestVersion, "2.5.0");
  assert.equal(stillOld.notesUrl, previous.notesUrl);
  assert.equal(stillOld.available, true);

  const updated = await checkForUpdate({
    currentVersion: "2.5.0",
    previous,
    fetchImpl: offline,
  });
  assert.equal(updated.available, false, "already on the version the last check found");
});
