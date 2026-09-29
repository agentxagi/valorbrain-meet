// Content script for Google Meet: participant names, active speaker, the
// in-page status pill, the private late-joiner brief and leave-call detection.
// It never restyles Meet itself (all styles are scoped, see content.css).
import {
  collectParticipantNames,
  participantNameFromCandidate,
  type ParticipantNameCandidate,
} from "./participantDetection.ts";
import { shortcutKeys } from "./ui/shortcut.ts";

(() => {
  const LOG = "[ValorBrainMeet]";

  const SELECTORS = {
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
  };

  /** Labels of the buttons Meet shows only after you leave or the call ends. */
  const POST_CALL_LABELS =
    /^(participar novamente|voltar à tela inicial|voltar para a tela inicial|rejoin|return to home screen|volver a unirse|volver a la pantalla principal)$/i;
  const POST_CALL_TEXTS =
    /(você saiu da reunião|você saiu da chamada|a reunião terminou|a chamada terminou|you left the meeting|you've left the meeting|the meeting has ended|you've been removed|você foi removido)/i;

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

  function isMeetingRoomPath(): boolean {
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname);
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
    const existing = queryFirst(SELECTORS.chatInput);
    if (existing) return existing;
    queryFirst(SELECTORS.chatToggleButtons)?.click();
    for (let i = 0; i < 10; i += 1) {
      await wait(300);
      const input = queryFirst(SELECTORS.chatInput);
      if (input) return input;
    }
    return null;
  }

  async function sendChatMessage(message: string): Promise<boolean> {
    try {
      const chatInput = await ensureChatPanelOpen();
      if (!chatInput) return false;
      setInputValue(chatInput, message);
      await wait(150);
      const sendButton = queryFirst(SELECTORS.sendButton) as HTMLButtonElement | null;
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
      return true;
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

  function collectParticipants(): { participants: string[]; selfName: string | null } {
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

  function postCallScreenVisible(): boolean {
    const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"]');
    for (const button of buttons) {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
      if (label && label.length < 40 && POST_CALL_LABELS.test(label)) return true;
    }
    const headings = document.querySelectorAll<HTMLElement>('h1, h2, [role="heading"]');
    for (const heading of headings) {
      if (POST_CALL_TEXTS.test(heading.textContent || "")) return true;
    }
    return false;
  }

  function startLeaveDetection() {
    if (leaveTimer) return;
    leaveReported = false;
    leaveTimer = setInterval(() => {
      if (leaveReported || !postCallScreenVisible()) return;
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
      void sendChatMessage(message.text).then((success) => sendResponse({ success }));
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
