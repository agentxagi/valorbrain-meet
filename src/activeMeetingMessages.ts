import { meetingRefFromUrl, platformForUrl } from "./platforms";

interface ActiveMeetingMessageSource {
  senderTabId?: number;
  senderUrl?: string;
  targetTabId?: number | null;
  meetingId?: string | null;
}

/**
 * Content-script messages (participants, speaker, microphone state) count only
 * when they come from the tab being recorded and that tab is still in the same
 * call. Teams is the exception on the second check: its web client drops the
 * meeting id from the URL once the call starts, so the recorded tab on a Teams
 * host is trusted by its tab id.
 */
export function isMessageFromActiveMeeting({
  senderTabId,
  senderUrl,
  targetTabId,
  meetingId,
}: ActiveMeetingMessageSource): boolean {
  if (senderTabId === undefined || targetTabId == null || senderTabId !== targetTabId) {
    return false;
  }

  const platform = platformForUrl(senderUrl);
  if (!platform) return false;
  if (platform === "teams") return true;

  const senderMeetingId = meetingRefFromUrl(senderUrl)?.meetingId;
  if (!senderMeetingId) return false;

  return !meetingId || meetingId === "unknown" || senderMeetingId === meetingId;
}
