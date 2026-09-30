import test from "node:test";
import assert from "node:assert/strict";

import { isMessageFromActiveMeeting } from "./activeMeetingMessages.ts";

const ACTIVE_MEETING = {
  targetTabId: 42,
  meetingId: "cat-room-dog",
};

test("accepts content-script messages from the active Meet tab", () => {
  assert.equal(
    isMessageFromActiveMeeting({
      ...ACTIVE_MEETING,
      senderTabId: 42,
      senderUrl: "https://meet.google.com/cat-room-dog",
    }),
    true,
  );
});

test("rejects messages from another Meet tab", () => {
  assert.equal(
    isMessageFromActiveMeeting({
      ...ACTIVE_MEETING,
      senderTabId: 99,
      senderUrl: "https://meet.google.com/owl-room-fox",
    }),
    false,
  );
});

test("rejects messages when the tab id matches but the Meet room does not", () => {
  assert.equal(
    isMessageFromActiveMeeting({
      ...ACTIVE_MEETING,
      senderTabId: 42,
      senderUrl: "https://meet.google.com/owl-room-fox",
    }),
    false,
  );
});

test("rejects messages without an owned target tab or valid Meet URL", () => {
  assert.equal(
    isMessageFromActiveMeeting({
      senderTabId: 42,
      senderUrl: "https://meet.google.com/cat-room-dog",
      targetTabId: null,
      meetingId: "cat-room-dog",
    }),
    false,
  );
  assert.equal(
    isMessageFromActiveMeeting({
      ...ACTIVE_MEETING,
      senderTabId: 42,
      senderUrl: "https://example.com/cat-room-dog",
    }),
    false,
  );
});

test("allows a valid sender URL while the active meeting id is unknown", () => {
  assert.equal(
    isMessageFromActiveMeeting({
      senderTabId: 42,
      senderUrl: "https://meet.google.com/cat-room-dog",
      targetTabId: 42,
      meetingId: "unknown",
    }),
    true,
  );
});

test("Zoom: the recorded tab must stay in the same meeting number", () => {
  const zoom = { targetTabId: 7, meetingId: "zoom-85012345678" };
  assert.equal(
    isMessageFromActiveMeeting({
      ...zoom,
      senderTabId: 7,
      senderUrl: "https://app.zoom.us/wc/85012345678/join",
    }),
    true,
  );
  assert.equal(
    isMessageFromActiveMeeting({
      ...zoom,
      senderTabId: 7,
      senderUrl: "https://app.zoom.us/wc/99912345678/join",
    }),
    false,
  );
});

test("Teams: the recorded tab is trusted by id even after the URL loses the meeting", () => {
  const teams = {
    targetTabId: 9,
    meetingId: "teams-nja4yze4zmqtywjj",
    meetingUrl:
      "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_NjA4YzE4ZmQtYWJjZC00ZWY@thread.v2/0",
  };
  assert.equal(
    isMessageFromActiveMeeting({
      ...teams,
      senderTabId: 9,
      senderUrl: "https://teams.microsoft.com/v2/",
    }),
    true,
  );
  assert.equal(
    isMessageFromActiveMeeting({
      ...teams,
      senderTabId: 10,
      senderUrl: "https://teams.microsoft.com/v2/",
    }),
    false,
    "another Teams tab is ignored",
  );
  assert.equal(
    isMessageFromActiveMeeting({
      ...teams,
      senderTabId: 9,
      senderUrl: "https://teams.microsoft.com.evil.com/v2/",
    }),
    false,
  );
});

test("Teams: another meeting's id, or a recording that did not start on Teams, is not trusted", () => {
  const teams = {
    targetTabId: 9,
    meetingId: "teams-nja4yze4zmqtywjj",
    meetingUrl: "https://teams.live.com/meet/9390567463821",
  };
  assert.equal(
    isMessageFromActiveMeeting({
      ...teams,
      meetingId: "teams-9390567463821",
      senderTabId: 9,
      senderUrl: "https://teams.live.com/meet/1111111111111",
    }),
    false,
  );
  assert.equal(
    isMessageFromActiveMeeting({
      targetTabId: 9,
      meetingId: "Aba do navegador",
      meetingUrl: "https://example.com/webinar",
      senderTabId: 9,
      senderUrl: "https://teams.microsoft.com/v2/",
    }),
    false,
    "a generic tab recording that later shows Teams",
  );
});
