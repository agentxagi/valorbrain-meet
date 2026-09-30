// Content script for the meeting page (Google Meet; Zoom and Microsoft Teams
// web as best effort): participant names, active speaker, the in-page status
// pill, the private late-joiner brief, chat messages and leave-call detection.
// It never restyles the meeting app (all styles are scoped, see content.css).
import {
  collectParticipantNames,
  participantNameFromCandidate,
  type ParticipantNameCandidate,
} from "./participantDetection.ts";
import { micMutedFromLabel, PLATFORM_DOM, splitDisplayName } from "./platformDom.ts";
import { meetingRefFromUrl, platformForHostname } from "./platforms.ts";
import { shortcutKeys } from "./ui/shortcut.ts";

(() => {
  const LOG = "[ValorBrainMeet]";
  const PLATFORM = platformForHostname(location.hostname) ?? "meet";
  const DOM = PLATFORM_DOM[PLATFORM];

  // Selectors for this page's platform (see platformDom.ts).
  const SELECTORS = {
    chatToggleButtons: DOM.chatToggleButtons,
    chatInput: DOM.chatInput,
    sendButton: DOM.sendButton,
    participantNodes: DOM.participantNodes,
    participantTile: DOM.participantTile,
    activeSpeakerIndicators: DOM.activeSpeakerIndicators,
  };

  /** Labels of the buttons shown only after you leave or the call ends. */
  const POST_CALL_LABELS = DOM.postCallLabels;
  const POST_CALL_TEXTS = DOM.postCallTexts;

  const SYMBOL_SVG =
    '<svg class="vbm-symbol" aria-hidden="true" viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="1000" rx="225" fill="#111317"/><path d="M448.85395478 750.0 245.0 250.00000145999996H397.129817L505.64908646000004 568.45841838L616.19675348 250.00000145999996H766.2981729200001L562.44421814 750.0Z" fill="#FFFFFF"/><circle cx="731" cy="676" r="74" fill="#3F9E5E"/></svg>';
  const STOP_SVG =
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const CLOSE_SVG =
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  function queryFirst(
    selectors: string[],
    root: Document | HTMLElement = document,
  ): HTMLElement | null {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el as HTMLElement;
    }
    return null;
  }

  function getTextValue(el: HTMLElement | null): string {
    if (!el) return "";
    if ("value" in el) return String((el as HTMLInputElement).value || "").trim();
    return String(el.textContent || "").trim();
  }

  function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Whether this page is the call itself. Meet: the room URL. Zoom and Teams
   * keep the call in a single-page app, so the call toolbar decides.
   */
  function isMeetingRoomPath(): boolean {
    if (DOM.postCallPath?.test(location.pathname)) return false;
    if (PLATFORM === "meet") return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname);
    if (PLATFORM === "zoom" && !/^\/wc\//.test(location.pathname)) return false;
    return DOM.inCallIndicators.some((selector) => Boolean(document.querySelector(selector)));
  }

  /** Hidden duplicates (another chat's compose box, a collapsed panel) never count. */
  function isVisible(el: Element | null): el is HTMLElement {
    if (!el) return false;
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  }

  function queryFirstVisible(selectors: string[]): HTMLElement | null {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (isVisible(el)) return el as HTMLElement;
      }
    }
    return null;
  }

  // ——— Chat (optional public late-joiner message) ———

  function setInputValue(el: HTMLElement, value: string) {
    el.focus();
    try {
      document.execCommand("selectAll", false, undefined);
      document.execCommand("insertText", false, value);
    } catch {
      if ("value" in el) (el as HTMLInputElement).value = value;
      else el.textContent = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function ensureChatPanelOpen(): Promise<HTMLElement | null> {
    const existing = queryFirstVisible(SELECTORS.chatInput);
    if (existing) return existing;
    queryFirstVisible(SELECTORS.chatToggleButtons)?.click();
    for (let i = 0; i < 10; i += 1) {
      await wait(300);
      const input = queryFirstVisible(SELECTORS.chatInput);
      if (input) return input;
    }
    return null;
  }

  /** The chat box emptied after sending: the message really left. */
  async function composeBoxCleared(chatInput: HTMLElement, message: string): Promise<boolean> {
    const probe = message.slice(0, 40);
    for (let i = 0; i < 8; i += 1) {
      await wait(150);
      if (!document.contains(chatInput) || !getTextValue(chatInput).includes(probe)) return true;
    }
    return false;
  }

  /**
   * Types and sends a message in this call's chat. `expectedMeetingId` (when
   * given) must still be the room on screen. Returns true only when the chat
   * box emptied, i.e. the message was sent.
   */
  async function sendChatMessage(message: string, expectedMeetingId?: string): Promise<boolean> {
    try {
      // Zoom and Teams also show private chats on the same page: not until
      // their meeting chat has been checked on real calls (platformDom.ts).
      if (!DOM.chatVerified) return false;
      if (!isMeetingRoomPath()) return false;
      // The tab may have moved to another room since the worker asked.
      const shownMeetingId = meetingRefFromUrl(location.href)?.meetingId;
      if (expectedMeetingId && shownMeetingId !== expectedMeetingId) return false;
      const chatInput = await ensureChatPanelOpen();
      if (!chatInput) return false;
      setInputValue(chatInput, message);
      await wait(150);
      const sendButton = queryFirstVisible(SELECTORS.sendButton) as HTMLButtonElement | null;
      if (
        sendButton &&
        !sendButton.disabled &&
        sendButton.getAttribute("aria-disabled") !== "true"
      ) {
        sendButton.click();
      } else {
        chatInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
        );
      }
      return await composeBoxCleared(chatInput, message);
    } catch (err) {
      console.error(`${LOG} could not send the chat message:`, err);
      return false;
    }
  }

  // ——— Private late-joiner brief ———

  function showBrief(briefContent: string, targetName?: string) {
    let overlay = document.getElementById("vbm-brief");
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "vbm-brief";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "false");
      overlay.setAttribute("aria-labelledby", "vbm-brief-title");
      overlay.innerHTML = `
        <div class="vbm-brief-head">
          ${SYMBOL_SVG}
          <span class="vbm-brief-eyebrow">ValorBrain Meet</span>
          <button type="button" class="vbm-brief-close" aria-label="Fechar">${CLOSE_SVG}</button>
        </div>
        <h2 class="vbm-brief-title" id="vbm-brief-title"></h2>
        <p class="vbm-brief-text"></p>
        <p class="vbm-brief-footer">Resumo privado: só você vê esta janela.</p>`;
      document.body.appendChild(overlay);
      const close = () => {
        overlay?.classList.remove("vbm-visible");
        setTimeout(() => {
          overlay?.remove();
          if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
        }, 300);
      };
      overlay.querySelector(".vbm-brief-close")?.addEventListener("click", close);
      overlay.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Escape") close();
      });
    }
    const title = overlay.querySelector(".vbm-brief-title");
    if (title)
      title.textContent = targetName ? `${targetName} acabou de entrar` : "Resumo da reunião";
    const text = overlay.querySelector(".vbm-brief-text");
    if (text) text.textContent = String(briefContent || "Sem resumo disponível ainda.");
    requestAnimationFrame(() => overlay?.classList.add("vbm-visible"));
  }

  // ——— Participants & active speaker ———

  function closestParticipantTile(el: Element): HTMLElement | null {
    for (const selector of SELECTORS.participantTile) {
      const tile = el.closest(selector);
      if (tile) return tile as HTMLElement;
    }
    return null;
  }

  function hasActiveSpeakerCue(el: Element): boolean {
    const ariaLabel = String(el.getAttribute("aria-label") || "");
    if (/(speaking|falando|hablando)/i.test(ariaLabel)) return true;
    if (
      el.getAttribute("data-is-speaking") === "true" ||
      el.getAttribute("data-speaking") === "true" ||
      el.getAttribute("data-active-speaker") === "true"
    ) {
      return true;
    }
    if (
      /\b(active[-_\s]?speaker|is[-_\s]?speaking|voice[-_\s]?active)\b/i.test(
        String(el.getAttribute("class") || ""),
      )
    ) {
      return true;
    }
    return SELECTORS.activeSpeakerIndicators.some((selector) =>
      Boolean(el.querySelector(selector)),
    );
  }

  /** "Mais opções para Ana Souza" (tile menu), in the languages Meet ships. */
  const MORE_OPTIONS_FOR =
    /^(?:Mais opções para|More options for|Más opciones para|Plus d'options pour)\s+(.{1,80})$/i;
  /** "Conta do Google: Nome Sobrenome (email)" (account button in the header). */
  const GOOGLE_ACCOUNT =
    /^(?:Conta do Google|Google Account|Cuenta de Google|Compte Google):\s*(.+?)\s*(?:\(|$)/i;
  /** "Nome (você)" / "Name (you)" marks the local user. */
  const YOU_SUFFIX = /\s*\((?:você|voce|you|tú|vous)\)\s*$/i;
  let accountName: string | null = null;

  function participantNameFromTile(tile: HTMLElement): string | null {
    const name = meetParticipantNameFromTile(tile);
    if (!name || PLATFORM === "meet") return name;
    return splitDisplayName(name).name || null;
  }

  function meetParticipantNameFromTile(tile: HTMLElement): string | null {
    // Most reliable first: the tile's own menu ("Mais opções para Ana Souza"),
    // the self-name attribute, the name element; the tile text only last
    // (it also holds icon ligatures and button labels).
    for (const labelled of tile.querySelectorAll<HTMLElement>("[aria-label]")) {
      const fromMenu = MORE_OPTIONS_FOR.exec(labelled.getAttribute("aria-label") || "")?.[1];
      if (fromMenu) {
        const name = participantNameFromCandidate({ text: fromMenu.replace(YOU_SUFFIX, "") });
        if (name) return name;
      }
    }
    const selfAttr =
      tile.getAttribute("data-self-name") ||
      tile.querySelector("[data-self-name]")?.getAttribute("data-self-name");
    if (selfAttr) {
      const name = participantNameFromCandidate({ selfName: selfAttr });
      if (name && !/^(you|você|voce)$/i.test(name)) return name;
    }
    const nameElement = queryFirst(SELECTORS.participantNodes, tile);
    const fromElement = participantNameFromCandidate({
      ariaLabel: nameElement?.getAttribute("aria-label"),
      selfName: null,
      text: getTextValue(nameElement),
    });
    if (fromElement) return fromElement;
    return participantNameFromCandidate({
      ariaLabel: tile.getAttribute("aria-label"),
      text: getTextValue(tile),
    });
  }

  /** Zoom / Teams: the name elements, without "(Host, me)" / "(Convidado)" markers. */
  function collectPlatformParticipants(): { participants: string[]; selfName: string | null } {
    const names = new Set<string>();
    let selfName: string | null = null;
    for (const selector of SELECTORS.participantNodes) {
      document.querySelectorAll<HTMLElement>(selector).forEach((node) => {
        const raw =
          getTextValue(node) ||
          node.getAttribute("title") ||
          (node.getAttribute("aria-label") || "").split(",")[0];
        const { name, isSelf } = splitDisplayName(raw || "");
        const clean = participantNameFromCandidate({ text: name });
        if (!clean) return;
        names.add(clean);
        if (isSelf && !selfName) selfName = clean;
      });
    }
    return { participants: names.size > 0 ? [...names] : ["You"], selfName };
  }

  function collectParticipants(): { participants: string[]; selfName: string | null } {
    if (PLATFORM !== "meet") return collectPlatformParticipants();
    const candidates: ParticipantNameCandidate[] = [];
    const elements = new Set<HTMLElement>();
    let selfName: string | null = null;
    for (const selector of SELECTORS.participantNodes) {
      document.querySelectorAll(selector).forEach((node) => elements.add(node as HTMLElement));
    }
    for (const element of elements) {
      if (!selfName) {
        const rawSelf = element.getAttribute("data-self-name");
        if (rawSelf) selfName = participantNameFromCandidate({ selfName: rawSelf });
      }
      candidates.push({
        ariaLabel: element.getAttribute("aria-label"),
        selfName: element.getAttribute("data-self-name"),
        text: getTextValue(element),
      });
    }
    // Every video tile has a "Mais opções para <Nome>" button; the local user's
    // own name comes from the Google account button or a "(você)" label.
    for (const labelled of document.querySelectorAll<HTMLElement>("[aria-label]")) {
      const label = labelled.getAttribute("aria-label") || "";
      const tileName = MORE_OPTIONS_FOR.exec(label)?.[1];
      if (tileName) candidates.push({ text: tileName.replace(YOU_SUFFIX, "") });
      if (!accountName) {
        const account = GOOGLE_ACCOUNT.exec(label)?.[1];
        if (account) accountName = participantNameFromCandidate({ text: account });
      }
      if (!selfName && YOU_SUFFIX.test(label) && label.length < 90) {
        selfName = participantNameFromCandidate({ text: label.replace(YOU_SUFFIX, "") });
      }
    }
    const names = collectParticipantNames(candidates).map((name) =>
      name.replace(YOU_SUFFIX, "").trim(),
    );
    return {
      participants: Array.from(new Set(names.filter(Boolean))),
      selfName: selfName || accountName,
    };
  }

  let participantTimer: ReturnType<typeof setInterval> | null = null;
  let lastParticipantsKey = "";

  function startParticipantPolling() {
    if (participantTimer) return;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      const { participants, selfName } = collectParticipants();
      const key = `${selfName ?? ""}|${participants.join("\u0001")}`;
      if (key === lastParticipantsKey) return;
      lastParticipantsKey = key;
      try {
        await chrome.runtime.sendMessage({ type: "PARTICIPANTS_UPDATED", participants, selfName });
      } catch {
        lastParticipantsKey = ""; // service worker asleep: resend next tick
      }
    };
    void tick();
    participantTimer = setInterval(tick, 5000);
  }

  function stopParticipantPolling() {
    if (participantTimer) clearInterval(participantTimer);
    participantTimer = null;
    lastParticipantsKey = "";
  }

  let speakerObserver: MutationObserver | null = null;
  let speakerCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSpeaker: string | null = null;

  function detectActiveSpeaker() {
    const candidates = new Set<HTMLElement>();
    SELECTORS.activeSpeakerIndicators.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        const tile = closestParticipantTile(node);
        if (tile) candidates.add(tile);
      });
    });
    document.querySelectorAll(SELECTORS.participantTile.join(",")).forEach((node) => {
      if (hasActiveSpeakerCue(node)) candidates.add(node as HTMLElement);
    });
    for (const tile of candidates) {
      const name = participantNameFromTile(tile);
      if (name && name !== lastSpeaker) {
        lastSpeaker = name;
        chrome.runtime.sendMessage({ type: "ACTIVE_SPEAKER_CHANGED", name }).catch(() => {
          lastSpeaker = null;
        });
        return;
      }
      if (name) return;
    }
  }

  function startSpeakerDetection() {
    if (speakerObserver) return;
    speakerObserver = new MutationObserver(() => {
      if (speakerCheckTimer) return;
      speakerCheckTimer = setTimeout(() => {
        speakerCheckTimer = null;
        detectActiveSpeaker();
      }, 300);
    });
    speakerObserver.observe(document.body, {
      attributes: true,
      attributeFilter: [
        "class",
        "aria-label",
        "data-is-speaking",
        "data-speaking",
        "data-active-speaker",
      ],
      childList: true,
      subtree: true,
    });
    detectActiveSpeaker();
  }

  function stopSpeakerDetection() {
    speakerObserver?.disconnect();
    speakerObserver = null;
    if (speakerCheckTimer) clearTimeout(speakerCheckTimer);
    speakerCheckTimer = null;
    lastSpeaker = null;
  }

  // ——— Leave-call detection ———

  let leaveTimer: ReturnType<typeof setInterval> | null = null;
  let leaveReported = false;
  /** Zoom/Teams: the call controls were seen in this recording (their loss = hang-up). */
  let callControlsSeen = false;
  let callControlsMissingTicks = 0;

  /**
   * Zoom and Teams keep the page after hanging up: the call toolbar going away
   * (for ~6 s, so a re-render does not count) means the call ended.
   */
  function callControlsGone(): boolean {
    if (PLATFORM === "meet" || DOM.inCallIndicators.length === 0) return false;
    const present = DOM.inCallIndicators.some((selector) =>
      isVisible(document.querySelector(selector)),
    );
    if (present) {
      callControlsSeen = true;
      callControlsMissingTicks = 0;
      return false;
    }
    if (!callControlsSeen) return false;
    callControlsMissingTicks += 1;
    return callControlsMissingTicks >= 4;
  }

  function postCallScreenVisible(): boolean {
    if (DOM.postCallPath?.test(location.pathname)) return true;
    const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"]');
    for (const button of buttons) {
      if (!isVisible(button)) continue;
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
      if (label && label.length < 40 && POST_CALL_LABELS.test(label)) return true;
    }
    const headings = document.querySelectorAll<HTMLElement>('h1, h2, [role="heading"]');
    for (const heading of headings) {
      if (isVisible(heading) && POST_CALL_TEXTS.test(heading.textContent || "")) return true;
    }
    return false;
  }

  function startLeaveDetection() {
    if (leaveTimer) return;
    leaveReported = false;
    callControlsSeen = false;
    callControlsMissingTicks = 0;
    leaveTimer = setInterval(() => {
      if (leaveReported) return;
      const gone = callControlsGone();
      if (!gone && !postCallScreenVisible()) return;
      leaveReported = true;
      chrome.runtime.sendMessage({ type: "MEETING_ENDED" }).catch(() => {
        leaveReported = false;
      });
    }, 1500);
  }

  function stopLeaveDetection() {
    if (leaveTimer) clearInterval(leaveTimer);
    leaveTimer = null;
  }

  // ——— Meet microphone mute state ———
  // While the user is muted in Meet nobody hears them, so the recording drops
  // the microphone. Only a button clearly labelled as the microphone counts:
  // the camera toggle carries the same data-is-muted attribute.

  const MIC_LABEL = /micro(?:fone|phone|́fono|fono)/i;
  let micTimer: ReturnType<typeof setInterval> | null = null;
  let lastMicMuted: boolean | null = null;

  function meetMicMuted(): boolean | null {
    if (PLATFORM !== "meet") {
      // Zoom/Teams: the toggle's label says what a click would do ("Unmute").
      for (const button of document.querySelectorAll<HTMLElement>(DOM.micButtons.join(","))) {
        const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`;
        const muted = micMutedFromLabel(label);
        if (muted !== null) return muted;
      }
      return null;
    }
    for (const button of document.querySelectorAll<HTMLElement>("[data-is-muted]")) {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-tooltip") || ""}`;
      if (MIC_LABEL.test(label)) return button.getAttribute("data-is-muted") === "true";
    }
    return null;
  }

  function startMicStateReporting() {
    if (micTimer) return;
    lastMicMuted = null;
    const tick = () => {
      const muted = meetMicMuted();
      if (muted === null || muted === lastMicMuted) return;
      lastMicMuted = muted;
      chrome.runtime.sendMessage({ type: "MEET_MIC_STATE", muted }).catch(() => {
        lastMicMuted = null; // service worker asleep: resend next tick
      });
    };
    tick();
    micTimer = setInterval(tick, 1000);
  }

  function stopMicStateReporting() {
    if (micTimer) clearInterval(micTimer);
    micTimer = null;
    lastMicMuted = null;
  }

  // ——— Status pill ———

  interface ContentState {
    isActive?: boolean;
    audioActive?: boolean;
    finalizing?: boolean;
    startTime?: number | null;
    isTargetTab?: boolean;
  }

  let pillState: "hidden" | "hint" | "recording" | "saving" | "done" = "hidden";
  let pillTimer: ReturnType<typeof setInterval> | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let hintDismissed = false;
  let recordingStart = 0;
  // Filled from GET_STATE with the binding Chrome really assigned ("" = none).
  let recordShortcut = "";

  function shortcutMarkup(shortcut: string): string {
    return shortcutKeys(shortcut)
      .map((key) => {
        const kbd = document.createElement("span");
        kbd.className = "vbm-kbd";
        kbd.textContent = key;
        return kbd.outerHTML;
      })
      .join("+");
  }

  function pill(): HTMLElement {
    let el = document.getElementById("vbm-pill");
    if (!el) {
      el = document.createElement("div");
      el.id = "vbm-pill";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
      requestAnimationFrame(() => el?.classList.add("vbm-visible"));
    }
    return el;
  }

  function removePill() {
    document.getElementById("vbm-pill")?.remove();
    if (pillTimer) clearInterval(pillTimer);
    pillTimer = null;
  }

  function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function renderPill(next: typeof pillState) {
    if (next === pillState && next !== "recording") return;
    pillState = next;
    if (pillTimer) clearInterval(pillTimer);
    pillTimer = null;

    if (next === "hidden") {
      removePill();
      return;
    }
    const el = pill();
    if (next === "hint") {
      const how = recordShortcut
        ? `${shortcutMarkup(recordShortcut)} <span class="vbm-muted">ou o ícone da extensão</span>`
        : `<span class="vbm-muted">clique no ícone do ValorBrain Meet</span>`;
      el.innerHTML = `${SYMBOL_SVG}<span class="vbm-text">Gravar esta reunião: ${how}</span><button type="button" class="vbm-icon" data-act="dismiss" aria-label="Ocultar">${CLOSE_SVG}</button>`;
    } else if (next === "recording") {
      el.innerHTML = `<span class="vbm-dot" aria-hidden="true"></span><span class="vbm-text"><span class="vbm-rec-label">Gravando</span> <span class="vbm-timer">${formatClock(Date.now() - recordingStart)}</span> <span class="vbm-muted">· ValorBrain Meet</span></span><button type="button" class="vbm-stop" data-act="stop">${STOP_SVG}Encerrar</button>`;
      pillTimer = setInterval(() => {
        const timer = document.querySelector("#vbm-pill .vbm-timer");
        if (timer) timer.textContent = formatClock(Date.now() - recordingStart);
      }, 1000);
    } else if (next === "saving") {
      el.innerHTML = `<span class="vbm-spinner" aria-hidden="true"></span><span class="vbm-text">Salvando a reunião no ValorBrain…</span>`;
    } else if (next === "done") {
      el.innerHTML = `${SYMBOL_SVG}<span class="vbm-text">Gravação encerrada. <span class="vbm-muted">Veja o resultado no ícone da extensão.</span></span>`;
    }

    el.querySelector<HTMLButtonElement>('[data-act="dismiss"]')?.addEventListener("click", () => {
      hintDismissed = true;
      renderPill("hidden");
    });
    el.querySelector<HTMLButtonElement>('[data-act="stop"]')?.addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      button.textContent = "Encerrando…";
      chrome.runtime.sendMessage({ type: "MANUAL_STOP_AUDIO" }).catch(() => {
        button.disabled = false;
      });
    });
  }

  function applyState(state: ContentState) {
    const recordingHere = Boolean(state.audioActive && state.isTargetTab);
    const savingHere = Boolean(state.finalizing && state.isTargetTab);

    if (state.isActive || recordingHere) startParticipantPolling();
    else stopParticipantPolling();

    // Mute state is reported while this tab is the meeting (so the recording
    // starts with the right state) and while it records.
    if (state.isActive || recordingHere) startMicStateReporting();
    else stopMicStateReporting();

    if (recordingHere) {
      recordingStart = state.startTime || recordingStart || Date.now();
      startSpeakerDetection();
      startLeaveDetection();
    } else {
      stopSpeakerDetection();
      stopLeaveDetection();
    }

    if (doneTimer && (recordingHere || savingHere)) {
      clearTimeout(doneTimer);
      doneTimer = null;
    }

    if (savingHere) {
      renderPill("saving");
    } else if (recordingHere) {
      renderPill("recording");
    } else if (pillState === "saving" || pillState === "recording") {
      renderPill("done");
      doneTimer = setTimeout(() => {
        doneTimer = null;
        renderPill(isMeetingRoomPath() && !hintDismissed ? "hint" : "hidden");
      }, 6000);
    } else if (pillState !== "done") {
      renderPill(
        isMeetingRoomPath() && !hintDismissed && !postCallScreenVisible() ? "hint" : "hidden",
      );
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SHOW_BRIEF") {
      showBrief(message.briefContent, message.targetName);
      sendResponse({ success: true });
      return false;
    }
    if (message?.type === "SEND_CHAT_MESSAGE") {
      const expected =
        typeof message.expectedMeetingId === "string" ? message.expectedMeetingId : undefined;
      void sendChatMessage(message.text, expected).then((success) => sendResponse({ success }));
      return true;
    }
    if (message?.type === "STATE_UPDATE") {
      applyState((message.state ?? {}) as ContentState);
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && participantTimer) lastParticipantsKey = "";
  });

  // Initial render: ask the service worker what is going on.
  chrome.runtime
    .sendMessage({ type: "GET_STATE" })
    .then((state) => {
      if (!state) return;
      const shortcut = typeof state.recordShortcut === "string" ? state.recordShortcut : "";
      if (shortcut !== recordShortcut) {
        recordShortcut = shortcut;
        // A STATE_UPDATE broadcast can draw the hint before this reply lands;
        // redraw it so it shows the real binding instead of the fallback text.
        if (pillState === "hint") {
          pillState = "hidden";
          renderPill("hint");
        }
      }
      applyState({
        isActive: state.isActive,
        audioActive: state.audioActive,
        finalizing: state.finalizing,
        startTime: state.startTime,
        isTargetTab: state.isTargetTab === true,
      });
    })
    .catch(() => {
      if (isMeetingRoomPath()) renderPill("hint");
    });

  // Meet renders the lobby first; show the hint once the room UI exists.
  const bootTimer = setInterval(() => {
    if (pillState === "hidden" && isMeetingRoomPath() && !hintDismissed && document.body) {
      renderPill("hint");
    }
    if (pillState !== "hidden") clearInterval(bootTimer);
  }, 2000);
})();
