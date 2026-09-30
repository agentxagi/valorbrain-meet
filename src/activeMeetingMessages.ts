import { meetingRefFromUrl, platformForUrl } from "./platforms";

interface ActiveMeetingMessageSource {
  senderTabId?: number;
  senderUrl?: string;
  targetTabId?: number | null;
  meetingId?: string | null;
  /** URL the recording started on (decides the Teams rule below). */
  meetingUrl?: string | null;
}

/**
 * Content-script messages (participants, speaker, microphone state) count only
 * when they come from the tab being recorded and that tab is still in the same
 * call. Teams is the exception on the second check: its web client drops the
 * meeting id from the URL once the call starts, so a recording that started on
 * Teams trusts its own tab on a Teams host by the tab id (unless the URL shows
 * another meeting's id).
 */
export function isMessageFromActiveMeeting({
  senderTabId,
  senderUrl,
  targetTabId,
  meetingId,
  meetingUrl,
}: ActiveMeetingMessageSource): boolean {
  if (senderTabId === undefined || targetTabId == null || senderTabId !== targetTabId) {
    return false;
  }

  const platform = platformForUrl(senderUrl);
  if (!platform) return false;
  if (platform === "teams" && platformForUrl(meetingUrl) === "teams") {
    const senderMeeting = meetingRefFromUrl(senderUrl)?.meetingId;
    return !senderMeeting || !meetingId || meetingId === "unknown" || senderMeeting === meetingId;
  }

  const senderMeetingId = meetingRefFromUrl(senderUrl)?.meetingId;
  if (!senderMeetingId) return false;

  return !meetingId || meetingId === "unknown" || senderMeetingId === meetingId;
}
