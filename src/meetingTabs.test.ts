import test from "node:test";
import assert from "node:assert/strict";

import { getMeetingIdFromUrl, resolveManualMeetTab } from "./meetingTabs.ts";

type MockTab = Pick<chrome.tabs.Tab, "id" | "url" | "active"> & {
  currentWindow?: boolean;
};

function mockChromeTabs(tabs: MockTab[]) {
  const previousChrome = (globalThis as any).chrome;

  (globalThis as any).chrome = {
    tabs: {
      query: async (queryInfo: chrome.tabs.QueryInfo) => {
        if (queryInfo.active && queryInfo.currentWindow) {
          return tabs.filter((tab) => tab.active && tab.currentWindow) as chrome.tabs.Tab[];
        }

        const patterns = Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url];
        if (patterns.includes("https://meet.google.com/*")) {
          const hosts =
            /^https:\/\/(meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com)\//;
          return tabs.filter((tab) => hosts.test(tab.url ?? "")) as chrome.tabs.Tab[];
        }

        return [];
      },
    },
  };

  return () => {
    (globalThis as any).chrome = previousChrome;
  };
}

test("meeting id extraction accepts real Meet rooms and rejects non-room URLs", () => {
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/abc-defg-hij"), "abc-defg-hij");
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/new"), null);
  assert.equal(getMeetingIdFromUrl("https://example.com/abc-defg-hij"), null);
  assert.equal(getMeetingIdFromUrl(undefined), null);
});

test("meeting id extraction rejects non-meeting paths under meet.google.com", () => {
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/landing"), null);
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/calling"), null);
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/support"), null);
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/about"), null);
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/"), null);
  // Uppercase IDs are not valid (Meet IDs are always lowercase)
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/ABC-DEFG-HIJ"), null);
  // Too many / too few segments
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/ab-cdef-ghi"), null);
  assert.equal(getMeetingIdFromUrl("https://meet.google.com/abcd-defg-hijk"), null);
});

test("manual Meet tab resolution prefers the active meeting tab", async () => {
  const cleanup = mockChromeTabs([
    {
      id: 1,
      url: "https://meet.google.com/old-rmxx-aaa",
      active: false,
      currentWindow: true,
    },
    {
      id: 2,
      url: "https://meet.google.com/liv-room-bbb",
      active: true,
      currentWindow: true,
    },
  ]);

  try {
    const selected = await resolveManualMeetTab();
    assert.equal(selected.tab.id, 2);
    assert.equal(selected.meetingId, "liv-room-bbb");
  } finally {
    cleanup();
  }
});

test("manual Meet tab resolution falls back when exactly one meeting tab is open", async () => {
  const cleanup = mockChromeTabs([
    {
      id: 3,
      url: "https://example.com/",
      active: true,
      currentWindow: true,
    },
    {
      id: 4,
      url: "https://meet.google.com/onl-room-ccc",
      active: false,
      currentWindow: true,
    },
  ]);

  try {
    const selected = await resolveManualMeetTab();
    assert.equal(selected.tab.id, 4);
    assert.equal(selected.meetingUrl, "https://meet.google.com/onl-room-ccc");
  } finally {
    cleanup();
  }
});

test("manual Meet tab resolution rejects ambiguous background meetings", async () => {
  const cleanup = mockChromeTabs([
    {
      id: 5,
      url: "https://example.com/",
      active: true,
      currentWindow: true,
    },
    {
      id: 6,
      url: "https://meet.google.com/fir-stro-ddd",
      active: false,
      currentWindow: true,
    },
    {
      id: 7,
      url: "https://meet.google.com/sec-ondo-eee",
      active: false,
      currentWindow: false,
    },
  ]);

  try {
    await assert.rejects(resolveManualMeetTab(), /mais de uma reunião/);
  } finally {
    cleanup();
  }
});

test("meeting id extraction recognizes Zoom web client and Teams calls", () => {
  assert.equal(
    getMeetingIdFromUrl("https://app.zoom.us/wc/85012345678/join?fromPWA=1"),
    "zoom-85012345678",
  );
  assert.equal(getMeetingIdFromUrl("https://app.zoom.us/wc/join/85012345678"), "zoom-85012345678");
  assert.equal(
    getMeetingIdFromUrl("https://us05web.zoom.us/wc/9876543210/start"),
    "zoom-9876543210",
  );
  // Launcher pages are not the call itself.
  assert.equal(getMeetingIdFromUrl("https://us05web.zoom.us/j/9876543210?pwd=x"), null);
  assert.equal(
    getMeetingIdFromUrl("https://teams.live.com/meet/9390567463821?p=abc"),
    "teams-9390567463821",
  );
  assert.equal(
    getMeetingIdFromUrl(
      "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_ZDM4NzQ4ZGMtODk3Ni00YjA1@thread.v2/0?context=%7b%7d",
    ),
    "teams-zdm4nzq4zgmtodk3",
  );
  assert.equal(getMeetingIdFromUrl("https://teams.microsoft.com/v2/"), null);
});

test("manual tab resolution finds a single open Zoom call", async () => {
  const cleanup = mockChromeTabs([
    { id: 8, url: "https://example.com/", active: true, currentWindow: true },
    { id: 9, url: "https://app.zoom.us/wc/85012345678/join", active: false, currentWindow: true },
  ]);
  try {
    const selected = await resolveManualMeetTab();
    assert.equal(selected.tab.id, 9);
    assert.equal(selected.meetingId, "zoom-85012345678");
    assert.equal(selected.platform, "zoom");
  } finally {
    cleanup();
  }
});
