import { MeetTabSelection } from "./meetingTabs";

export interface PopupCaptureStartPayload {
  tabId: number;
  meetingId: string;
  meetingUrl: string | null;
  streamId: string;
  includeMicrophone: boolean;
}

export interface PopupCaptureStartResponse {
  success?: boolean;
  error?: string;
}

export interface PopupCaptureStartResult {
  meetingId: string;
  microphoneEnabled: boolean;
  response: PopupCaptureStartResponse;
}

interface PopupCaptureStartOptions {
  resolveMeetTab: () => Promise<MeetTabSelection>;
  getMediaStreamId: (tabId: number) => Promise<string>;
  requestMicrophonePermission: () => Promise<boolean>;
  startAudioCapture: (payload: PopupCaptureStartPayload) => Promise<PopupCaptureStartResponse>;
}

export async function startPopupAudioCapture({
  resolveMeetTab,
  getMediaStreamId,
  requestMicrophonePermission,
  startAudioCapture,
}: PopupCaptureStartOptions): Promise<PopupCaptureStartResult> {
  const { tab: meetTab, meetingId, meetingUrl } = await resolveMeetTab();

  if (meetTab.id === undefined) {
    throw new Error("A aba da reunião não tem identificador. Recarregue a página do Meet.");
  }

  const streamId = await getMediaStreamId(meetTab.id);

  if (!streamId) {
    throw new Error(
      "O Chrome não liberou a captura desta aba. Na aba da reunião, clique de novo no ícone do ValorBrain Meet.",
    );
  }

  let microphoneEnabled: boolean;
  try {
    microphoneEnabled = await requestMicrophonePermission();
  } catch {
    microphoneEnabled = false;
  }

  const response = await startAudioCapture({
    tabId: meetTab.id,
    meetingId,
    meetingUrl: meetingUrl || meetTab.url || null,
    streamId,
    includeMicrophone: microphoneEnabled,
  });

  if (!response?.success) {
    throw new Error(response?.error || "Não foi possível iniciar a gravação.");
  }

  return { meetingId, microphoneEnabled, response };
}
