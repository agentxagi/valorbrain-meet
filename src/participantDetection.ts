export const MAX_PARTICIPANT_NAME_LEN = 120;

const EXCLUDED_PARTICIPANT_LABELS = new Set([
  "Audio on",
  "Camera off",
  "Camera on",
  "Meeting host",
  "More options",
  "Mute",
  "Muted",
  "Pin",
  "Presentation",
  "Unmute",
  "Unpin",
  "You",
]);

export interface ParticipantNameCandidate {
  ariaLabel?: string | null;
  selfName?: string | null;
  text?: string | null;
}

const EXCLUDED_REGEXES = Array.from(EXCLUDED_PARTICIPANT_LABELS).map((label) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "gi");
});

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Meet draws its icons with Material Symbols ligatures, so an element's text
 * holds words like "more_vert" or "mic_off" next to the name, plus menu glyphs.
 */
function stripIconText(value: string): string {
  return value.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, " ").replace(/[⋮⋯•·▾▸►◂◀✕×]/g, " ");
}

function stripExcludedLabels(value: string): string {
  let cleaned = cleanText(stripIconText(value));
  if (!cleaned) return "";

  for (const regex of EXCLUDED_REGEXES) {
    cleaned = cleaned.replace(regex, " ");
  }

  cleaned = cleaned.replace(/(^|\s)[-/]+(?=\s|$)/g, " ").replace(/\(\s*\)/g, " ");

  return cleanText(cleaned);
}

const LOWERCASE_EXCLUDED_LABELS = new Set(
  Array.from(EXCLUDED_PARTICIPANT_LABELS).map((label) => label.toLowerCase()),
);

/**
 * The suffix Meet writes after a display name, in the languages it ships:
 * "(você)" / "(You)" on the local user, "(Your Presentation)" /
 * "(Sua apresentação)" on the local user's screen share, and "(Presentation)"
 * / "(Apresentação)" on someone else's. "(Your )" is what an older build left
 * of "(Your Presentation)" after dropping the word "Presentation".
 */
const SELF_MARKER =
  /\s*\((?:you|você|voce|tú|tu|vous|(?:your|sua|seu|su|votre)(?:\s[^()]*)?)\s*\)\s*$/i;
const PRESENTATION_MARKER =
  /\s*\((?:presentation|apresentação|apresentacao|presentación|presentacion|présentation)\)\s*$/i;

/**
 * Splits Meet's marker from a display name: "Ana Souza (Your Presentation)"
 * → { name: "Ana Souza", isSelf: true }; "Bruno (Apresentação)" →
 * { name: "Bruno", isSelf: false }. A name without a marker comes back as is.
 */
export function splitMeetNameMarker(raw: string): { name: string; isSelf: boolean } {
  const value = cleanText(raw);
  if (SELF_MARKER.test(value)) {
    return { name: cleanText(value.replace(SELF_MARKER, "")), isSelf: true };
  }
  return { name: cleanText(value.replace(PRESENTATION_MARKER, "")), isSelf: false };
}

/**
 * The name in an element's text (icon ligatures, control labels and Meet's
 * marker removed) and whether the marker says it is the local user. The
 * marker is read before and after the cleanup: "Ana (Your Presentation)
 * more_vert" and "Ana (Your Presentation) Muted" both are the local user.
 */
export function meetDisplayName(raw: string): { name: string; isSelf: boolean } {
  const first = splitMeetNameMarker(stripIconText(raw));
  const second = splitMeetNameMarker(stripExcludedLabels(first.name));
  return { name: second.name, isSelf: first.isSelf || second.isSelf };
}

export function participantNameFromCandidate(candidate: ParticipantNameCandidate): string | null {
  const selfName = splitMeetNameMarker(candidate.selfName || "").name;
  const text = meetDisplayName(candidate.text || "").name;
  const ariaLabel = splitMeetNameMarker(candidate.ariaLabel || "").name;

  const participantAriaName = ariaLabel.startsWith("Participant:")
    ? ariaLabel.replace(/^Participant:\s*/, "")
    : "";

  const rawName = selfName || participantAriaName || text;
  const name = cleanText(rawName);

  const maxParticipantNameLength =
    typeof MAX_PARTICIPANT_NAME_LEN === "number" && Number.isFinite(MAX_PARTICIPANT_NAME_LEN)
      ? MAX_PARTICIPANT_NAME_LEN
      : 120;

  if (!name || name.length > maxParticipantNameLength || name.includes("…")) {
    return null;
  }

  if (LOWERCASE_EXCLUDED_LABELS.has(name.toLowerCase())) {
    return null;
  }

  return name;
}

export function collectParticipantNames(candidates: ParticipantNameCandidate[]): string[] {
  const names = new Set<string>();

  for (const candidate of candidates) {
    const name = participantNameFromCandidate(candidate);
    if (name) names.add(name);
  }

  const participantNames = [...names];
  return participantNames.length > 0 ? participantNames : ["You"];
}
