/**
 * @fileoverview Who is speaking, read from Google Meet's live captions.
 *
 * With captions on (the CC button), Meet shows one block per speaker turn: the
 * speaker's display name, then the words, which Meet keeps rewriting while the
 * person talks. The local user's blocks carry "Você" / "You" instead of the
 * name. Captions are the one place in the call page where Meet names who is
 * talking; the tiles only animate a sound indicator, with no name or label
 * that says who it is.
 *
 * The content script hands every text change inside the caption region to
 * {@link CaptionSpeakerTracker.turn}; a block seen for the first time is a new
 * turn, and its speaker becomes an active-speaker event. Meet also rewrites
 * the blocks above the last one (it corrects recent words), and those
 * rewrites are not new turns.
 *
 * Pure module (the DOM is reached through {@link CaptionNode}), unit-tested in
 * node.
 */

import { meetDisplayName, participantNameFromCandidate } from "./participantDetection";

/** The part of a caption element the tracker reads (an Element in the page). */
export interface CaptionNode {
  readonly textContent: string | null;
  readonly previousElementSibling: CaptionNode | null;
  readonly parentElement: CaptionNode | null;
}

/** Meet's label for the local user in captions, in the languages it ships. */
export const CAPTION_SELF_LABEL = /^(?:you|você|voce|tú|tu|vous)$/i;

/** A display name is short and is not a sentence. */
const MAX_NAME_LENGTH = 80;
const MAX_NAME_WORDS = 8;

/**
 * The speaker written above a caption's text, or null when the text above is
 * not a name (a heading, a button, another caption).
 */
export function captionSpeakerName(raw: string | null | undefined): string | null {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (CAPTION_SELF_LABEL.test(text)) return text;
  const name = participantNameFromCandidate({ text: meetDisplayName(text).name });
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  if (name.split(" ").length > MAX_NAME_WORDS || /[.?!:;]$/.test(name)) return null;
  return name;
}

/** Turns caption text changes into speaker turns (one instance per recording). */
export class CaptionSpeakerTracker {
  private readonly seen = new WeakSet<object>();

  /**
   * `textElement` is the element whose text changed (for a changed text node,
   * its parent). Returns the speaker when this is the first text of a caption
   * block, else null.
   */
  turn(textElement: CaptionNode | null | undefined): string | null {
    if (!textElement) return null;
    const block = textElement.parentElement;
    const nameElement = textElement.previousElementSibling;
    if (!block || !nameElement || this.seen.has(block)) return null;
    if (!String(textElement.textContent ?? "").trim()) return null;
    const speaker = captionSpeakerName(nameElement.textContent);
    if (!speaker) return null;
    this.seen.add(block);
    return speaker;
  }
}
