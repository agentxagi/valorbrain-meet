import { MEETING_TAB_URLS, meetingRefFromUrl, type MeetingPlatform } from "./platforms";

export interface MeetTabSelection {
  tab: chrome.tabs.Tab;
  meetingId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
}

/**
 * The meeting id of a call tab: `abc-defg-hij` on Google Meet, `zoom-<number>`
 * on the Zoom web client, `teams-<id>` on Microsoft Teams (see platforms.ts).
 * Null for anything that is not a call.
 */
export function getMeetingIdFromUrl(url: string | undefined): string | null {
  return meetingRefFromUrl(url)?.meetingId ?? null;
}

function toMeetTabSelection(tab: chrome.tabs.Tab | undefined): MeetTabSelection | null {
  const ref = meetingRefFromUrl(tab?.url);
  if (!tab || tab.id === undefined || !ref || !tab.url) return null;

  return {
    tab,
    meetingId: ref.meetingId,
    meetingUrl: tab.url,
    platform: ref.platform,
  };
}

export async function resolveManualMeetTab(): Promise<MeetTabSelection> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeMeetTab = toMeetTabSelection(activeTab);
  if (activeMeetTab) return activeMeetTab;

  const meetTabs = (await chrome.tabs.query({ url: MEETING_TAB_URLS }))
    .map(toMeetTabSelection)
    .filter((tab): tab is MeetTabSelection => Boolean(tab));

  if (meetTabs.length === 0) {
    throw new Error(
      "Nenhuma reunião aberta (Google Meet, Zoom ou Teams). Entre na reunião primeiro.",
    );
  }

  if (meetTabs.length === 1) {
    return meetTabs[0];
  }

  throw new Error("Há mais de uma reunião aberta. Vá para a aba da reunião e tente de novo.");
}

export async function resolveDetectedMeetTab(): Promise<MeetTabSelection | null> {
  try {
    return await resolveManualMeetTab();
  } catch {
    return null;
  }
}
