import { MeetTabSelection } from "./meetingTabs";

export interface DashboardCaptureStartPayload {
  tabId: number;
  meetingId: string;
  meetingUrl: string | null;
  streamId: string;
  includeMicrophone: boolean;
}

export interface DashboardCaptureStartResponse {
  success?: boolean;
  error?: string;
}

export interface DashboardCaptureStartResult {
  meetingId: string;
  microphoneEnabled: boolean;
  response: DashboardCaptureStartResponse;
}

interface DashboardCaptureStartOptions {
  resolveMeetTab: () => Promise<MeetTabSelection>;
  getMediaStreamId: (tabId: number) => Promise<string>;
  requestMicrophonePermission: () => Promise<boolean>;
  startAudioCapture: (
    payload: DashboardCaptureStartPayload,
  ) => Promise<DashboardCaptureStartResponse>;
}

export async function startDashboardAudioCapture({
  resolveMeetTab,
  getMediaStreamId,
  requestMicrophonePermission,
  startAudioCapture,
}: DashboardCaptureStartOptions): Promise<DashboardCaptureStartResult> {
  const { tab: meetTab, meetingId, meetingUrl } = await resolveMeetTab();

  if (meetTab.id === undefined) {
    throw new Error("A aba da reunião não tem identificador. Recarregue a página do Meet.");
  }

  const streamId = await getMediaStreamId(meetTab.id);

  if (!streamId) {
    throw new Error(
      "O Chrome não liberou a captura desta aba. Clique no ícone do ValorBrain Meet na aba da reunião e inicie por lá.",
    );
  }

  let microphoneEnabled = false;
  try {
    microphoneEnabled = await requestMicrophonePermission();
  } catch {
    // Microphone capture is optional; the offscreen document can still record tab audio.
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
