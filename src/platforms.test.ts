import test from "node:test";
import assert from "node:assert/strict";

import {
  MEETING_TAB_URLS,
  meetingRefFromUrl,
  navigatedAwayFromCall,
  platformForHostname,
  platformForUrl,
  platformLabelForUrl,
  stableMeetingId,
} from "./platforms.ts";

test("platform detection uses exact hostnames only", () => {
  assert.equal(platformForHostname("meet.google.com"), "meet");
  assert.equal(platformForHostname("app.zoom.us"), "zoom");
  assert.equal(platformForHostname("us05web.zoom.us"), "zoom");
  assert.equal(platformForHostname("zoom.us"), "zoom");
  assert.equal(platformForHostname("teams.microsoft.com"), "teams");
  assert.equal(platformForHostname("teams.live.com"), "teams");
  assert.equal(platformForHostname("teams.cloud.microsoft"), "teams");

  assert.equal(platformForHostname("meet.google.com.evil.com"), null);
  assert.equal(platformForHostname("evilzoom.us"), null);
  assert.equal(platformForHostname("zoom.us.evil.com"), null);
  assert.equal(platformForHostname("teams.microsoft.com.evil.com"), null);
  assert.equal(platformForHostname("notteams.microsoft.com"), null);
  assert.equal(platformForHostname(""), null);
});

test("only https URLs are meeting URLs", () => {
  assert.equal(platformForUrl("http://meet.google.com/abc-defg-hij"), null);
  assert.equal(meetingRefFromUrl("http://app.zoom.us/wc/85012345678/join"), null);
  assert.equal(platformForUrl("not a url"), null);
  assert.equal(platformForUrl(undefined), null);
});

test("Google Meet rooms keep the strict room format", () => {
  assert.deepEqual(meetingRefFromUrl("https://meet.google.com/abc-defg-hij?authuser=0"), {
    platform: "meet",
    meetingId: "abc-defg-hij",
  });
  assert.equal(meetingRefFromUrl("https://meet.google.com/new"), null);
  assert.equal(meetingRefFromUrl("https://meet.google.com/landing"), null);
  assert.equal(meetingRefFromUrl("https://evil.com/meet.google.com/abc-defg-hij"), null);
});

test("Zoom: only the web client call pages carry a meeting", () => {
  assert.deepEqual(meetingRefFromUrl("https://app.zoom.us/wc/85012345678/join?pwd=x"), {
    platform: "zoom",
    meetingId: "zoom-85012345678",
  });
  assert.equal(
    meetingRefFromUrl("https://app.zoom.us/wc/join/85012345678")?.meetingId,
    "zoom-85012345678",
  );
  assert.equal(meetingRefFromUrl("https://app.zoom.us/wc/home"), null);
  assert.equal(meetingRefFromUrl("https://zoom.us/j/85012345678"), null);
  assert.equal(
    meetingRefFromUrl("https://app.zoom.us/wc/12345/join"),
    null,
    "too short for a meeting number",
  );
});

test("Teams: thread id from join links, numeric id from /meet links", () => {
  const joinLink =
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjA4YzE4ZmQtYWJjZC00ZWY%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d";
  assert.deepEqual(meetingRefFromUrl(joinLink), {
    platform: "teams",
    meetingId: "teams-nja4yze4zmqtywjj",
  });
  const webClient =
    "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_NjA4YzE4ZmQtYWJjZC00ZWY@thread.v2/0";
  assert.equal(
    meetingRefFromUrl(webClient)?.meetingId,
    "teams-nja4yze4zmqtywjj",
    "same call, same id",
  );
  assert.equal(
    meetingRefFromUrl("https://teams.microsoft.com/meet/2468013579?p=abc")?.meetingId,
    "teams-2468013579",
  );
  assert.equal(
    meetingRefFromUrl("https://teams.live.com/meet/9390567463821")?.meetingId,
    "teams-9390567463821",
  );
  assert.equal(
    meetingRefFromUrl("https://teams.microsoft.com/v2/"),
    null,
    "chat, calendar: not a call",
  );
  assert.equal(
    meetingRefFromUrl("https://teams.microsoft.com/l/meetup-join/19%ZZmeeting_bad"),
    null,
  );
});

test("tab query patterns and labels cover every platform", () => {
  assert.ok(MEETING_TAB_URLS.includes("https://meet.google.com/*"));
  assert.ok(MEETING_TAB_URLS.includes("https://*.zoom.us/wc/*"));
  assert.ok(MEETING_TAB_URLS.includes("https://teams.microsoft.com/*"));
  assert.equal(platformLabelForUrl("https://app.zoom.us/wc/85012345678/join"), "Zoom");
  assert.equal(platformLabelForUrl("https://teams.live.com/meet/9390567463821"), "Microsoft Teams");
  assert.equal(platformLabelForUrl("https://meet.google.com/abc-defg-hij"), "Google Meet");
});

const MEET = "https://meet.google.com/abc-defg-hij";
const ZOOM = "https://app.zoom.us/wc/85012345678/join";
const TEAMS_JOIN =
  "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_NjA4YzE4ZmQtYWJjZC00ZWY@thread.v2/0";
const TEAMS_ID = "teams-nja4yze4zmqtywjj";

test("Meet and Zoom: leaving the meeting id in the URL ends the recording", () => {
  assert.equal(navigatedAwayFromCall(MEET, "abc-defg-hij", `${MEET}?authuser=0`), false);
  assert.equal(
    navigatedAwayFromCall(MEET, "abc-defg-hij", "https://meet.google.com/xyz-abcd-efg"),
    true,
  );
  assert.equal(navigatedAwayFromCall(MEET, "abc-defg-hij", "https://meet.google.com/"), true);
  assert.equal(navigatedAwayFromCall(MEET, "abc-defg-hij", "https://www.google.com/"), true);
  assert.equal(
    navigatedAwayFromCall(ZOOM, "zoom-85012345678", "https://app.zoom.us/wc/85012345678/join?x=1"),
    false,
  );
  assert.equal(
    navigatedAwayFromCall(ZOOM, "zoom-85012345678", "https://app.zoom.us/wc/85012345678/leave"),
    false,
    "leave page: caught in the page",
  );
  assert.equal(
    navigatedAwayFromCall(ZOOM, "zoom-85012345678", "https://app.zoom.us/wc/99912345678/join"),
    true,
  );
  assert.equal(navigatedAwayFromCall(ZOOM, "zoom-85012345678", "https://zoom.us/"), true);
});

test("Teams: a URL without the id proves nothing; another meeting or leaving Teams does", () => {
  assert.equal(
    navigatedAwayFromCall(TEAMS_JOIN, TEAMS_ID, "https://teams.microsoft.com/v2/"),
    false,
  );
  assert.equal(
    navigatedAwayFromCall(TEAMS_JOIN, TEAMS_ID, "https://teams.microsoft.com/v2/#/calendar"),
    false,
  );
  assert.equal(
    navigatedAwayFromCall(TEAMS_JOIN, TEAMS_ID, "https://teams.microsoft.com/meet/2468013579"),
    true,
  );
  assert.equal(
    navigatedAwayFromCall(TEAMS_JOIN, TEAMS_ID, "https://outlook.office.com/mail"),
    true,
  );
});

test("a recording that did not start on a call URL never stops on navigation", () => {
  assert.equal(
    navigatedAwayFromCall("https://example.com/webinar", "Webinar", "https://example.com/other"),
    false,
  );
  assert.equal(
    navigatedAwayFromCall(
      "https://app.zoom.us/rec/play/abc",
      "Replay",
      "https://app.zoom.us/rec/share/x",
    ),
    false,
  );
  assert.equal(navigatedAwayFromCall(null, null, MEET), false);
  // Started from the context menu on Teams, labelled by the tab title.
  assert.equal(
    navigatedAwayFromCall(
      "https://teams.microsoft.com/v2/",
      "Reunião | Microsoft Teams",
      "https://teams.microsoft.com/v2/#/chat",
    ),
    false,
  );
});

test("the notice is remembered only by an id taken from the call URL", () => {
  assert.equal(stableMeetingId(MEET, "abc-defg-hij"), "abc-defg-hij");
  assert.equal(stableMeetingId(TEAMS_JOIN, TEAMS_ID), TEAMS_ID);
  assert.equal(
    stableMeetingId("https://teams.microsoft.com/v2/", "Reunião semanal"),
    null,
    "a tab title",
  );
  assert.equal(stableMeetingId(MEET, "unknown"), null);
  assert.equal(stableMeetingId(null, "abc-defg-hij"), null);
});
