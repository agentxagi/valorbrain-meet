// Shared Configuration Constants for Late Meet

// AI Processing Limits
/** Maximum number of characters allowed in a single AI prompt before truncation. */
export const MAX_PROMPT_LENGTH = 2000;

/** Number of transcript entries included in the rolling context window sent to the AI. */
export const TRANSCRIPT_WINDOW_SIZE = 25;

/** Maximum number of tokens the AI may generate for a meeting summary response. */
export const SUMMARIZATION_MAX_TOKENS = 2400;

/** Character budget of new transcript text sent in one summarization pass. */
export const SUMMARY_TRANSCRIPT_CHAR_BUDGET = 14000;

/** Summary cadence bounds and default, in seconds (user-configurable in Settings). */
export const SUMMARY_MIN_INTERVAL_S = 120;
export const SUMMARY_DEFAULT_INTERVAL_S = 180;
export const SUMMARY_MAX_INTERVAL_S = 900;

/** The first summary runs once the transcript has this much text or this much time. */
export const FIRST_SUMMARY_MIN_CHARS = 350;
export const FIRST_SUMMARY_MIN_ELAPSED_S = 60;

/** Items per array kept in the STATE_UPDATE payload sent to the popup/side panel. */
export const UI_ARRAY_LIMIT = 400;

/**
 * Default transcription language (ISO 639-1); "auto" lets the model detect it
 * and locks it after the first clear segments (meetingLanguage.ts). The
 * product serves meetings in any language, so nothing is assumed.
 */
export const DEFAULT_TRANSCRIPTION_LANGUAGE = "auto";

/** Maximum number of tokens the AI may generate for a late-joiner briefing message. */
export const JOINER_MESSAGE_MAX_TOKENS = 120;

// Audio Pipeline
/** Maximum number of audio chunks that may be queued for processing before back-pressure is applied. */
export const MAX_PENDING_AUDIO_CHUNKS = 8;

/** Interval in milliseconds at which voice-activity detection (VAD) samples audio energy. */
export const VAD_SAMPLE_MS = 250;

/** Interval in milliseconds between waveform visualization updates in the UI. */
export const WAVEFORM_INTERVAL_MS = 100;

/** Number of amplitude buckets used to render the waveform bar graph. */
export const WAVEFORM_BUCKETS = 32;

/** Gain multiplier applied to raw audio amplitude values before rendering the waveform. */
export const WAVEFORM_GAIN = 6;

// Segments are cut at pauses, and the pause needed shrinks as a segment grows
// (see requiredPauseMs in segmenter.ts).

/** Maximum buffered audio duration in milliseconds before the buffer is force-flushed. */
export const MAX_BUFFER_MS = 28000;

/** Speech segments shorter than this are extended instead of flushed on a pause. */
export const MIN_SEGMENT_MS = 3000;

/** A segment with no speech at all is discarded (not transcribed) after this long. */
export const SILENT_SEGMENT_DISCARD_MS = 10000;

// Meeting Behavior
/**
 * Seconds to wait before sending the welcome/catch-up message, avoiding
 * transient lobby or join churn during the first moments of a meeting.
 */
export const MIN_MEETING_DURATION_FOR_WELCOME = 10;

/** Minimum milliseconds between consecutive state broadcast messages to listeners. */
export const BROADCAST_THROTTLE_MS = 500;

/**
 * When true, enables verbose console logging for development.
 * Vite replaces `import.meta.env.DEV` at build time, ensuring production builds
 * never accidentally enable debug output by flipping this constant.
 */
export const DEBUG = import.meta.env?.DEV === true;

/** Maximum number of pending audio chunks before pausing the recorder. */
export const MAX_PENDING_CHUNKS = 20;

/** Timeout in milliseconds for draining pending audio chunks before dropping them. */
export const DRAIN_TIMEOUT_MS = 30000;
