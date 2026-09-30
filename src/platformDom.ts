/**
 * @fileoverview Where each meeting platform keeps, in its web page, the things
 * the content script reads or uses: participant names, who is speaking, the
 * chat, the microphone button and the screen shown after leaving.
 *
 * Google Meet: the selectors the extension has shipped since 2.0.
 * Zoom (web client) and Microsoft Teams (web): best effort, written from the
 * public shape of those apps WITHOUT access to a real call, and backed by
 * generic fallbacks (aria-label/placeholder text). Anything here can be wrong
 * for them until checked against the live DOM; failures degrade to "no names /
 * no chat", never to a broken recording.
 *
 * Pure module (selectors and small parsers), unit-tested in node.
 */

import type { MeetingPlatform } from "./platforms";

export interface PlatformDom {
  /**
   * Whether the extension may type in this platform's meeting chat. Off for
   * Zoom and Teams until checked on real calls: their pages also hold private
   * chats (Zoom's "To:" keeps the last recipient; Teams' chat app stays open
   * beside the call), and a wrong guess would post into the wrong conversation.
   */
  chatVerified: boolean;
  /** Buttons that open the chat panel. */
  chatToggleButtons: string[];
  /** The chat message box (textarea or contenteditable). */
  chatInput: string[];
  sendButton: string[];
  /** Elements whose text/label is a participant name. */
  participantNodes: string[];
  /** The tile/row of one participant (for "who is speaking"). */
  participantTile: string[];
  activeSpeakerIndicators: string[];
  /** Button labels shown only after leaving the call. */
  postCallLabels: RegExp;
  /** Heading texts shown only after leaving the call. */
  postCallTexts: RegExp;
  /** Paths shown only after leaving the call. */
  postCallPath?: RegExp;
  /** Elements present only in the call; empty = the URL decides (Meet). */
  inCallIndicators: string[];
  /** Microphone toggle buttons (label says what a click would do). */
  micButtons: string[];
}

/** Generic chat fallbacks, tried after the platform's own selectors. */
const GENERIC_CHAT_INPUT = [
  'textarea[aria-label*="message" i]',
  'textarea[aria-label*="mensagem" i]',
  'div[contenteditable="true"][aria-label*="message" i]',
  'div[contenteditable="true"][aria-label*="mensagem" i]',
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="mensagem" i]',
];
const GENERIC_SEND = [
  'button[aria-label*="send" i]',
  'button[aria-label*="enviar" i]',
  'button[title*="send" i]',
  'button[title*="enviar" i]',
];

const MEET_POST_CALL_LABELS =
  /^(participar novamente|voltar à tela inicial|voltar para a tela inicial|rejoin|return to home screen|volver a unirse|volver a la pantalla principal)$/i;
const MEET_POST_CALL_TEXTS =
  /(você saiu da reunião|você saiu da chamada|a reunião terminou|a chamada terminou|you left the meeting|you've left the meeting|the meeting has ended|you've been removed|você foi removido)/i;

export const PLATFORM_DOM: Record<MeetingPlatform, PlatformDom> = {
  meet: {
    chatVerified: true,
    chatToggleButtons: [
      'button[aria-label*="Chat"]',
      'button[aria-label*="chat" i]',
      'button[data-panel-id="chat-pane"]',
    ],
    chatInput: [
      'textarea[aria-label="Chat text input"]',
      'textarea[name="chatTextInput"]',
      'textarea[aria-label*="mensagem" i]',
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"][aria-label*="mensagem" i]',
      'textarea[placeholder*="message" i]',
      'textarea[aria-label*="message" i]',
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Enviar mensagem" i]',
      'button[data-tooltip="Send message"]',
      'button[jsname][aria-label*="Send"]',
    ],
    participantNodes: [
      "[data-participant-id] [data-self-name]",
      '[data-participant-id] [role="heading"]',
      '[data-participant-id] span[class="notranslate"]',
      '[data-participant-id][aria-label^="Participant:"]',
      "[data-self-name]",
      'div[jsname="NfX98"]',
      '[aria-label^="Participant:"]',
    ],
    participantTile: [
      "[data-participant-id]",
      '[aria-label^="Participant:"]',
      "[data-self-name]",
      '[role="listitem"]',
      '[role="gridcell"]',
    ],
    activeSpeakerIndicators: [
      '[aria-label*="speaking" i]',
      '[aria-label*="falando" i]',
      '[aria-label*="hablando" i]',
      '[data-tooltip*="speaking" i]',
      '[data-tooltip*="falando" i]',
      '[data-is-speaking="true"]',
      '[data-speaking="true"]',
      '[data-active-speaker="true"]',
    ],
    postCallLabels: MEET_POST_CALL_LABELS,
    postCallTexts: MEET_POST_CALL_TEXTS,
    inCallIndicators: [],
    micButtons: ["[data-is-muted]"],
  },

  zoom: {
    chatVerified: false,
    chatToggleButtons: [
      'button[aria-label*="chat panel" i]',
      'button[aria-label*="bate-papo" i]',
      'button[aria-label*="chat" i]',
      "button.footer-button__chat-icon",
    ],
    chatInput: [
      '.chat-rtf-box__editor-outer [contenteditable="true"]',
      'div[contenteditable="true"].tiptap',
      "textarea.chat-box__chat-textarea",
      '[contenteditable="true"][aria-label*="type message" i]',
      '[contenteditable="true"][aria-label*="digite" i]',
      ...GENERIC_CHAT_INPUT,
    ],
    sendButton: ["button.chat-rtf-box__send", 'button[aria-label="send" i]', ...GENERIC_SEND],
    participantNodes: [
      ".participants-item__display-name",
      ".video-avatar__avatar-name",
      ".video-avatar__avatar-footer span",
      '[class*="participants-item__display-name"]',
    ],
    participantTile: [
      ".video-avatar__avatar",
      ".participants-li",
      '[class*="video-avatar__avatar"]',
      '[role="listitem"]',
    ],
    activeSpeakerIndicators: [
      ".speaker-active-container__video-frame",
      '[class*="avatar--speaking"]',
      '[class*="is-speaking"]',
      '[aria-label*="speaking" i]',
      '[aria-label*="falando" i]',
    ],
    postCallLabels: /^(rejoin|reingressar|entrar novamente|return to home|voltar ao início)$/i,
    postCallTexts:
      /(this meeting has been ended|the host has ended this meeting|you have left the meeting|you left the meeting|a reunião foi encerrada|o anfitrião encerrou|você saiu da reunião)/i,
    postCallPath: /^\/(?:wc\/(?:\d+\/)?leave|postattendee)/,
    inCallIndicators: [
      "#wc-footer",
      ".footer__leave-btn",
      'button[aria-label*="leave" i]',
      'button[aria-label*="sair" i]',
    ],
    micButtons: [
      'button[aria-label*="microphone" i]',
      'button[aria-label*="microfone" i]',
      'button[aria-label*="audio" i]',
      'button[aria-label*="áudio" i]',
    ],
  },

  teams: {
    chatVerified: false,
    chatToggleButtons: [
      "#chat-button",
      'button[data-tid="calling-toolbar-chat-button"]',
      'button[aria-label*="chat" i]',
      'button[aria-label*="conversa" i]',
    ],
    chatInput: [
      '[data-tid="ckeditor"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"][aria-label*="message" i]',
      'div[role="textbox"][contenteditable="true"][aria-label*="mensagem" i]',
      'div[role="textbox"][contenteditable="true"]',
      ...GENERIC_CHAT_INPUT,
    ],
    sendButton: [
      'button[data-tid="newMessageCommands-send"]',
      'button[name="send"]',
      ...GENERIC_SEND,
    ],
    participantNodes: [
      '[data-tid="roster-participant-name"]',
      '[data-tid="calling-participant-name"]',
      '[data-cid="calling-participant-stream"] [data-tid*="display-name"]',
      '[data-tid^="participantsInCall"] span[title]',
    ],
    participantTile: [
      '[data-cid="calling-participant-stream"]',
      '[data-tid="video-tile"]',
      "[data-stream-type]",
      '[role="listitem"]',
    ],
    activeSpeakerIndicators: [
      '[data-tid="voice-level-stream-outline"]',
      '[class*="speaking" i]',
      '[aria-label*="speaking" i]',
      '[aria-label*="falando" i]',
    ],
    postCallLabels: /^(rejoin|reingressar|ingressar novamente|voltar a entrar)$/i,
    postCallTexts:
      /(you left the meeting|you've left the meeting|the meeting has ended|call ended|você saiu da reunião|a reunião terminou|a chamada terminou|chamada encerrada)/i,
    inCallIndicators: [
      "#hangup-button",
      'button[data-tid="hangup-main-btn"]',
      'button[data-tid="call-hangup"]',
      '[data-tid="calling-toolbar"]',
    ],
    micButtons: ["#microphone-button", 'button[data-tid="toggle-mute"]'],
  },
};

/**
 * Reads the microphone state from a toggle's label, which says what a click
 * would do: "Unmute" / "Ativar som" means it is muted now. Null when the label
 * says neither.
 */
export function micMutedFromLabel(label: string): boolean | null {
  const text = String(label || "").toLowerCase();
  if (!text) return null;
  // `\b` keeps "ativar" from matching inside "desativar".
  if (
    /\bunmute\b|\bdesativar (o )?mudo\b|\bativar (o )?(som|áudio|audio|microfone)\b|\breativar (o )?(som|microfone)\b/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\bmute\b|\bativar (o )?mudo\b|\bsilenciar\b|\bdesativar (o )?(som|áudio|audio|microfone)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return null;
}

const TRAILING_PARENTHETICAL = /\s*\(([^()]{1,40})\)\s*$/;
const SELF_WORDS = /(^|[\s,])(me|eu|você|voce|you|tú|vous)([\s,]|$)/i;

/**
 * Splits the markers Zoom and Teams add after a display name ("Ana (Host, me)",
 * "Bruno (Convidado)", "Gustavo (Você)"): the bare name, and whether a marker
 * said it is the local user.
 */
export function splitDisplayName(raw: string): { name: string; isSelf: boolean } {
  let name = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  let isSelf = false;
  for (let i = 0; i < 3; i += 1) {
    const match = TRAILING_PARENTHETICAL.exec(name);
    if (!match) break;
    if (SELF_WORDS.test(match[1])) isSelf = true;
    name = name.slice(0, match.index).trim();
  }
  return { name, isSelf };
}
