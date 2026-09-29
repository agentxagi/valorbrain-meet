export const OFFSCREEN_ANALYSER_FFT_SIZE = 1024;

export const MICROPHONE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * One capture channel: the tab (everyone else in the meeting) or the
 * microphone (the person recording). Each channel has its own recorder
 * destination and analyser, so each is segmented and transcribed separately:
 * the microphone is always the recording user, and overlapping speech from
 * both sides is not lost to whoever is louder.
 */
export interface CaptureChannelGraph {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  destination: MediaStreamAudioDestinationNode;
}

function createChannelGraph(
  context: AudioContext,
  stream: MediaStream,
  playbackDestination?: AudioDestinationNode,
): CaptureChannelGraph {
  const source = context.createMediaStreamSource(stream);
  const destination = context.createMediaStreamDestination();
  const analyser = context.createAnalyser();
  analyser.fftSize = OFFSCREEN_ANALYSER_FFT_SIZE;

  source.connect(destination);
  source.connect(analyser);
  if (playbackDestination) source.connect(playbackDestination);

  return { source, analyser, destination };
}

/**
 * Tab audio: recorded, analysed and played back. Tab capture mutes the tab
 * for the user, so without the playback connection the meeting goes silent.
 */
export function createTabChannelGraph(
  context: AudioContext,
  tabStream: MediaStream,
): CaptureChannelGraph {
  return createChannelGraph(context, tabStream, context.destination);
}

/**
 * Microphone: recorded and analysed, never routed to the local output (that
 * would create monitoring and potentially audible feedback).
 */
export function createMicrophoneChannelGraph(
  context: AudioContext,
  microphoneStream: MediaStream,
): CaptureChannelGraph {
  return createChannelGraph(context, microphoneStream);
}
