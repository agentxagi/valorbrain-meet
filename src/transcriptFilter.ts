/**
 * @fileoverview Post-processing for speech-to-text responses.
 *
 * Whisper-family models invent text on silence or noise ("Legendas pela
 * comunidade Amara.org", "Obrigado por assistir", "Thanks for watching") and
 * sometimes loop on their own output. This module keeps only the text a user
 * would recognise as speech, using the verbose_json quality fields when the
 * server provides them and a conservative phrase list otherwise.
 *
 * Pure module: no Chrome APIs, unit-tested in node.
 */

export interface SttSegment {
  text?: string;
  start?: number;
  end?: number;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}

export interface SttResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: SttSegment[];
}

export type DropReason = "empty" | "hallucination" | "repeat" | "low-confidence";

export interface CleanTranscription {
  /** Text to append to the transcript; empty when nothing should be kept. */
  text: string;
  /** Why the whole chunk was dropped (only set when `text` is empty). */
  reason?: DropReason;
  /** Segment/sentence texts removed along the way (for debug logs). */
  dropped: string[];
  /** Audio duration in seconds reported by the server, when present. */
  durationSec?: number;
  /** Where speech starts inside the audio (first kept segment), when known. */
  speechStartSec?: number;
}

/**
 * Phrases that essentially never occur in a real meeting but are classic
 * Whisper hallucinations (YouTube subtitle credits and outros). Compared after
 * {@link normalizeForMatch}; a match anywhere in a sentence drops the sentence.
 */
const HARD_HALLUCINATIONS = [
  "legendas pela comunidade amara org",
  "legenda pela comunidade amara org",
  "legendas pela comunidade",
  "legenda adriana zanotto",
  "legendas adriana zanotto",
  "transcrição e legendas",
  "legendado por",
  "inscreva se no canal",
  "se inscreva no canal",
  "não se esqueça de se inscrever",
  "ative o sininho",
  "deixe seu like",
  "obrigado por assistir",
  "obrigada por assistir",
  "obrigado por assistirem",
  "até o próximo vídeo",
  "subtitles by the amara org community",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "subtítulos realizados por la comunidad de amara org",
  "gracias por ver el video",
];

/**
 * Short utterances that are legitimate in meetings but also the most common
 * silence hallucinations. They are only dropped when the server's quality
 * fields say the segment is probably not speech.
 */
const SOFT_HALLUCINATIONS = new Set([
  "obrigado",
  "obrigada",
  "obrigado a todos",
  "tchau",
  "você",
  "thank you",
  "thanks",
  "you",
  "bye",
]);

/** Minimum length for an exact repeat of a recent entry to be treated as a loop. */
const REPEAT_MIN_CHARS = 12;

/** Lower-cases, strips punctuation/symbols and collapses whitespace (keeps accents). */
export function normalizeForMatch(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the text is (or contains) a known subtitle-credit hallucination. */
export function isHardHallucination(text: string): boolean {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  return HARD_HALLUCINATIONS.some((phrase) => normalized.includes(phrase));
}

/** True for texts made only of music notes, brackets like [Música] or punctuation. */
export function isNonSpeechMarker(text: string): boolean {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  if (/^[\s♪♫.…,!?;:\-–—*"'()[\]]+$/u.test(trimmed)) return true;
  return /^[[(](música|musica|music|aplausos|applause|risos|laughter|silêncio|silence|inaudível|inaudible)[\])]\.?$/iu.test(
    trimmed,
  );
}

function segmentLooksLikeNoise(segment: SttSegment): boolean {
  const noSpeech = typeof segment.no_speech_prob === "number" ? segment.no_speech_prob : null;
  const logprob = typeof segment.avg_logprob === "number" ? segment.avg_logprob : null;
  const compression =
    typeof segment.compression_ratio === "number" ? segment.compression_ratio : null;

  // Same gates Whisper itself uses to decide a window is silence.
  if (noSpeech !== null && logprob !== null && noSpeech >= 0.6 && logprob <= -1.0) return true;
  // Highly repetitive output ("sim sim sim sim …").
  if (compression !== null && compression > 2.4) return true;
  // Very low confidence decodes are rarely real words.
  if (logprob !== null && logprob < -1.5) return true;
  return false;
}

function segmentIsUncertain(segment: SttSegment): boolean {
  const noSpeech = typeof segment.no_speech_prob === "number" ? segment.no_speech_prob : 0;
  const logprob = typeof segment.avg_logprob === "number" ? segment.avg_logprob : 0;
  return noSpeech >= 0.2 || logprob <= -0.8;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Removes the loops Whisper falls into on hesitant speech ("Ah, entendi. Ah,
 * entendi. Ah, entendi. …"): a phrase of 2–8 words repeated 3+ times in a row,
 * or a single word repeated 4+ times, is kept once. Real emphasis ("não, não,
 * não") stays.
 */
export function collapseRepeatedPhrases(text: string): string {
  const tokens = collapseWhitespace(text).split(" ").filter(Boolean);
  const keys = tokens.map((token) => normalizeForMatch(token));
  let changed = true;
  let words = tokens;
  let norm = keys;
  while (changed) {
    changed = false;
    for (let n = 1; n <= 8 && !changed; n += 1) {
      const minRepeats = n === 1 ? 4 : 3;
      for (let i = 0; i + n * minRepeats <= norm.length; i += 1) {
        const phrase = norm.slice(i, i + n);
        if (phrase.some((key) => !key)) continue;
        let repeats = 1;
        while (
          i + (repeats + 1) * n <= norm.length &&
          phrase.every((key, k) => norm[i + repeats * n + k] === key)
        ) {
          repeats += 1;
        }
        if (repeats >= minRepeats) {
          words = [...words.slice(0, i + n), ...words.slice(i + repeats * n)];
          norm = [...norm.slice(0, i + n), ...norm.slice(i + repeats * n)];
          changed = true;
          break;
        }
      }
    }
  }
  return words.join(" ");
}

/**
 * Cleans one STT response.
 *
 * @param response - Parsed JSON body (OpenAI `json` or `verbose_json` shape).
 * @param recentTexts - The last transcript entries' texts, newest last, used to
 *   detect the model repeating itself across chunks.
 */
export function cleanTranscription(
  response: SttResponse | null | undefined,
  recentTexts: string[] = [],
): CleanTranscription {
  const dropped: string[] = [];
  const durationSec =
    typeof response?.duration === "number" && Number.isFinite(response.duration)
      ? response.duration
      : undefined;

  const segments = Array.isArray(response?.segments) ? response!.segments! : [];
  let kept: string[] = [];
  let speechStartSec: number | undefined;

  if (segments.length > 0) {
    for (const segment of segments) {
      const text = collapseWhitespace(segment?.text || "");
      if (!text) continue;
      const normalized = normalizeForMatch(text);
      if (
        isNonSpeechMarker(text) ||
        isHardHallucination(text) ||
        segmentLooksLikeNoise(segment) ||
        (SOFT_HALLUCINATIONS.has(normalized) && segmentIsUncertain(segment))
      ) {
        dropped.push(text);
        continue;
      }
      if (speechStartSec === undefined && typeof segment.start === "number" && segment.start >= 0) {
        speechStartSec = segment.start;
      }
      kept.push(text);
    }
  } else {
    kept = [collapseWhitespace(response?.text || "")].filter(Boolean);
  }

  // Sentence-level pass for text-only responses and credits glued to speech.
  const sentences = splitSentences(kept.join(" ")).filter((sentence) => {
    if (isNonSpeechMarker(sentence) || isHardHallucination(sentence)) {
      dropped.push(sentence);
      return false;
    }
    return true;
  });

  const text = collapseRepeatedPhrases(collapseWhitespace(sentences.join(" ")));
  if (!text) {
    const reason: DropReason =
      dropped.length === 0
        ? "empty"
        : segments.some(segmentLooksLikeNoise)
          ? "low-confidence"
          : "hallucination";
    return { text: "", reason, dropped, durationSec };
  }

  const normalizedText = normalizeForMatch(text);
  if (normalizedText.length >= REPEAT_MIN_CHARS) {
    const recent = recentTexts.slice(-2).map(normalizeForMatch);
    if (recent.includes(normalizedText)) {
      return { text: "", reason: "repeat", dropped: [...dropped, text], durationSec };
    }
  }

  return { text, dropped, durationSec, speechStartSec };
}
