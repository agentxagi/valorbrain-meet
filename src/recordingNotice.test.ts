import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RECORDING_NOTICE,
  pruneRecordingNoticeLog,
  RECORDING_NOTICE_MAX_CHARS,
  RECORDING_NOTICE_REPEAT_MS,
  recordingNoticeKey,
  resolveRecordingNoticeText,
  shouldPostRecordingNotice,
} from "./recordingNotice.ts";

test("the default notice says it is recorded, by what, and how to object", () => {
  assert.match(DEFAULT_RECORDING_NOTICE, /gravada e transcrita pelo ValorBrain Meet/);
  assert.match(DEFAULT_RECORDING_NOTICE, /avise agora/);
  assert.match(DEFAULT_RECORDING_NOTICE, /https:\/\/meet\.valorbra\.in/);
  assert.ok(DEFAULT_RECORDING_NOTICE.length <= RECORDING_NOTICE_MAX_CHARS);
});

test("an empty or missing custom text falls back to the default", () => {
  assert.equal(resolveRecordingNoticeText(""), DEFAULT_RECORDING_NOTICE);
  assert.equal(resolveRecordingNoticeText("   \n "), DEFAULT_RECORDING_NOTICE);
  assert.equal(resolveRecordingNoticeText(undefined), DEFAULT_RECORDING_NOTICE);
  assert.equal(resolveRecordingNoticeText(42), DEFAULT_RECORDING_NOTICE);
});

test("a custom text becomes one line (Enter would send it early) within Meet's limit", () => {
  assert.equal(
    resolveRecordingNoticeText("Gravando\na reunião\t para o CRM."),
    "Gravando a reunião para o CRM.",
  );
  assert.equal(resolveRecordingNoticeText("x".repeat(900)).length, RECORDING_NOTICE_MAX_CHARS);
  assert.equal(resolveRecordingNoticeText("a\u0000b"), "a b");
});

test("the notice goes once per meeting, again only after the repeat window", () => {
  const key = recordingNoticeKey("meet", "abc-defg-hij");
  assert.equal(key, "meet:abc-defg-hij");
  const now = 10_000_000;
  assert.equal(shouldPostRecordingNotice({}, key, now), true);
  const log = { [key]: now };
  assert.equal(
    shouldPostRecordingNotice(log, key, now + 60_000),
    false,
    "stop/start in the same call",
  );
  assert.equal(shouldPostRecordingNotice(log, recordingNoticeKey("zoom", "zoom-850"), now), true);
  assert.equal(shouldPostRecordingNotice(log, key, now + RECORDING_NOTICE_REPEAT_MS), true);
});

test("the stored log keeps recent, well-formed entries only", () => {
  const now = RECORDING_NOTICE_REPEAT_MS * 10;
  const pruned = pruneRecordingNoticeLog(
    {
      "meet:new": now - 1000,
      "meet:old": now - RECORDING_NOTICE_REPEAT_MS - 1,
      "meet:bad": "yesterday",
    },
    now,
  );
  assert.deepEqual(pruned, { "meet:new": now - 1000 });
  assert.deepEqual(pruneRecordingNoticeLog(null, now), {});
  assert.deepEqual(pruneRecordingNoticeLog([1], now), {});
});
