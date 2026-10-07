// Popup: the main control. Shows what the extension is doing right now
// (ready / recording / saving / saved) and what is still missing in the setup.
import type { MeetingNotice, State } from "./types";
import { initTheme } from "./theme";
import { hydrateIcons, icon, type IconName } from "./ui/icons";
import { escapeHtml } from "./utils/domHelpers";
import {
  formatClock,
  formatDurationHuman,
  formatRelative,
  plural,
  speakerLabel,
} from "./ui/format";
import { getMeetingIdFromUrl } from "./meetingTabs";
import { shortcutKeys } from "./ui/shortcut";
import { getMicPermission, getSetupStatus, isSetupComplete, type SetupItem } from "./setupStatus";
import {
  compareVersions,
  UPDATE_PAGE_URL,
  UPDATE_STATUS_KEY,
  type UpdateStatus,
} from "./updateCheck";

void initTheme();

const LAST_SESSION_KEY = "lastSessionResult";
const DASHBOARD_TAB_KEY = "dashboardInitialTab";
/** Last-session card stays visible for this long after the meeting. */
const LAST_SESSION_VISIBLE_MS = 12 * 60 * 60 * 1000;

interface LastSessionResult {
  sessionId: string | null;
  savedAt: number;
  title: string;
  duration: number;
  transcriptEntries: number;
  empty: boolean;
  vb?: {
    status: "pending" | "sent" | "failed" | "skipped";
    at: number;
    docRef?: string | null;
    error?: string;
  };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let state: State | null = null;
let activeTab: chrome.tabs.Tab | undefined;
let lastSession: LastSessionResult | null = null;
let setupItems: SetupItem[] = [];
let updateStatus: UpdateStatus | null = null;
let timerHandle: ReturnType<typeof setInterval> | null = null;
let toastHandle: ReturnType<typeof setTimeout> | null = null;

function show(id: string, visible: boolean) {
  $(id).hidden = !visible;
}

function toast(message: string, kind: "info" | "error" = "info") {
  const el = $("pp-toast");
  el.textContent = message;
  el.className = `vb-toast${kind === "error" ? " vb-toast--error" : ""} is-visible`;
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.remove("is-visible"), 3200);
}

function openOptions(anchor = "") {
  void chrome.tabs.create({
    url: chrome.runtime.getURL(`src/options.html${anchor ? `#${anchor}` : ""}`),
  });
  window.close();
}

/** Must run synchronously inside the click handler (user gesture). */
function openSidePanel(initialTab?: "history" | "transcript") {
  if (initialTab) void chrome.storage.local.set({ [DASHBOARD_TAB_KEY]: initialTab });
  const target =
    activeTab?.id !== undefined
      ? { tabId: activeTab.id }
      : { windowId: activeTab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT };
  chrome.sidePanel
    .open(target as chrome.sidePanel.OpenOptions)
    .then(() => window.close())
    .catch((err) => toast(`Não consegui abrir o painel: ${err?.message || err}`, "error"));
}

function activeMeetingId(): string | null {
  return getMeetingIdFromUrl(activeTab?.url);
}

// ——— Rendering ———

function renderStatusLine() {
  const el = $("pp-status");
  el.className = "pp-status";
  if (state?.finalizing) {
    el.textContent = "Salvando a reunião…";
  } else if (state?.audioActive) {
    el.classList.add("pp-status--recording");
    const elapsed = state.startTime ? (Date.now() - state.startTime) / 1000 : 0;
    el.innerHTML = `<span class="vb-rec-dot"></span>Gravando · ${formatClock(elapsed)}`;
  } else if (activeMeetingId()) {
    el.textContent = "Pronto para gravar";
  } else if (state?.isActive && getMeetingIdFromUrl(state.meetingUrl ?? undefined)) {
    el.textContent = "Reunião aberta em outra aba";
  } else if (setupItems.some((item) => item.state === "missing")) {
    el.textContent = "Configuração pendente";
  } else {
    el.textContent = "Nenhuma reunião aberta";
  }
}

function renderNotice(notice: MeetingNotice | null | undefined) {
  const host = $("pp-notice");
  if (!notice) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const iconName: IconName =
    notice.severity === "error"
      ? "alertCircle"
      : notice.severity === "warning"
        ? "alertTriangle"
        : "info";
  host.hidden = false;
  host.innerHTML = `
    <div class="vb-notice vb-notice--${notice.severity}" role="${notice.severity === "error" ? "alert" : "status"}">
      ${icon(iconName)}
      <div class="vb-notice-body">${escapeHtml(notice.message)}</div>
      <button type="button" class="vb-icon-btn vb-notice-dismiss" aria-label="Dispensar aviso">${icon("x")}</button>
    </div>`;
  host.querySelector("button")?.addEventListener("click", () => {
    host.hidden = true;
    void chrome.runtime.sendMessage({ type: "DISMISS_NOTICE" }).catch(() => {});
  });
}

function renderRecording() {
  if (!state) return;
  const elapsed = state.startTime ? (Date.now() - state.startTime) / 1000 : 0;
  $("pp-rec-timer").textContent = formatClock(elapsed);
  const meeting = state.meetingId && state.meetingId !== "unknown" ? state.meetingId : "";
  const mic = state.micActive === false ? " · sem microfone" : "";
  $("pp-rec-meeting").textContent = `${meeting ? `${meeting}` : "Aba do navegador"}${mic}`;

  const transcriptCount = state.truncatedCounts?.transcript ?? state.transcript?.length ?? 0;
  $("pp-count-lines").textContent = String(transcriptCount);
  $("pp-count-decisions").textContent = String(
    state.truncatedCounts?.decisions ?? state.decisions?.length ?? 0,
  );
  $("pp-count-actions").textContent = String(
    state.truncatedCounts?.actionItems ?? state.actionItems?.length ?? 0,
  );

  const last = state.transcript?.at(-1);
  const lastLine = $("pp-last-line");
  if (last?.text) {
    lastLine.classList.remove("vb-muted");
    lastLine.innerHTML = `<strong>${escapeHtml(speakerLabel(last.speaker))}:</strong> ${escapeHtml(last.text)}`;
  } else {
    lastLine.classList.add("vb-muted");
    lastLine.textContent = "Aguardando a primeira fala…";
  }

  const summary = state.summary?.trim();
  show("pp-summary-block", Boolean(summary));
  $("pp-summary").textContent = summary || "";
}

function renderLastSession() {
  const card = $("pp-last");
  const recent = lastSession && Date.now() - lastSession.savedAt < LAST_SESSION_VISIBLE_MS;
  if (!lastSession || !recent || state?.audioActive || state?.finalizing) {
    card.hidden = true;
    return;
  }
  const s = lastSession;
  const meta = s.empty
    ? formatRelative(s.savedAt)
    : `${formatDurationHuman(s.duration)} · ${plural(s.transcriptEntries, "fala", "falas")} · ${formatRelative(s.savedAt)}`;

  let statusClass = "pending";
  let statusIcon: IconName | "spinner" = "cloudUpload";
  let statusText = "Salva neste navegador.";
  const actions: string[] = [];

  if (s.empty) {
    statusClass = "warning";
    statusIcon = "alertTriangle";
    statusText =
      "Nada foi transcrito nesta gravação. Confira o microfone e o servidor de transcrição.";
    actions.push(
      `<button class="vb-btn vb-btn--sm" data-act="settings" type="button">Abrir configurações</button>`,
    );
  } else if (s.vb?.status === "pending") {
    statusIcon = "spinner";
    statusText = "Enviando ao ValorBrain…";
  } else if (s.vb?.status === "sent") {
    statusClass = "success";
    statusIcon = "checkCircle";
    statusText = "Salva na memória do ValorBrain.";
  } else if (s.vb?.status === "failed") {
    statusClass = "error";
    statusIcon = "alertCircle";
    statusText = `Salva neste navegador, mas o envio ao ValorBrain falhou: ${s.vb.error || "erro desconhecido"}`;
    actions.push(
      `<button class="vb-btn vb-btn--primary vb-btn--sm" data-act="retry" type="button">${icon("refresh")}Tentar de novo</button>`,
    );
  } else if (s.vb?.status === "skipped") {
    const notConnected = /não conectado/i.test(s.vb.error || "");
    statusClass = "warning";
    statusIcon = "alertTriangle";
    statusText = notConnected
      ? "Salva só neste navegador. Conecte o ValorBrain para levar as reuniões à memória da empresa."
      : "Salva neste navegador. O envio automático está desligado.";
    actions.push(
      notConnected
        ? `<button class="vb-btn vb-btn--primary vb-btn--sm" data-act="connect" type="button">Conectar o ValorBrain</button>`
        : `<button class="vb-btn vb-btn--primary vb-btn--sm" data-act="retry" type="button">${icon("cloudUpload")}Enviar ao ValorBrain</button>`,
    );
  }
  if (!s.empty && s.sessionId) {
    actions.push(
      `<button class="vb-btn vb-btn--sm" data-act="open" type="button">${icon("history")}Ver no histórico</button>`,
    );
  }

  const statusIconHtml =
    statusIcon === "spinner"
      ? '<span class="vb-spinner" aria-hidden="true"></span>'
      : icon(statusIcon);

  card.hidden = false;
  card.innerHTML = `
    <div class="pp-last-head">
      <span class="vb-eyebrow">Última reunião</span>
      <button class="vb-icon-btn" data-act="dismiss" type="button" aria-label="Dispensar">${icon("x")}</button>
    </div>
    <div class="pp-last-title">${escapeHtml(s.title || "Reunião")}</div>
    <div class="pp-last-meta">${escapeHtml(meta)}</div>
    <div class="pp-last-status pp-last-status--${statusClass}">${statusIconHtml}<span>${escapeHtml(statusText)}</span></div>
    ${actions.length ? `<div class="pp-last-actions">${actions.join("")}</div>` : ""}`;

  card.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => void handleLastSessionAction(btn));
  });
}

async function handleLastSessionAction(btn: HTMLButtonElement) {
  const action = btn.dataset.act;
  if (action === "dismiss") {
    lastSession = null;
    renderLastSession();
    await chrome.runtime.sendMessage({ type: "CLEAR_LAST_SESSION" }).catch(() => {});
  } else if (action === "settings") {
    openOptions();
  } else if (action === "connect") {
    openOptions("valorbrain");
  } else if (action === "open") {
    openSidePanel("history");
  } else if (action === "retry" && lastSession?.sessionId) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "Enviando…";
    const result = await chrome.runtime
      .sendMessage({ type: "VB_SEND_SESSION", sessionId: lastSession.sessionId })
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (result?.ok) toast("Reunião enviada ao ValorBrain.");
    else toast(`O envio falhou: ${result?.error || "erro desconhecido"}`, "error");
    await loadLastSession();
    renderLastSession();
  }
}

function setupIcon(item: SetupItem): IconName {
  if (item.state === "ok") return "checkCircle";
  if (item.state === "warning") return "alertTriangle";
  return "alertCircle";
}

function renderSetup() {
  const section = $("pp-setup");
  if (
    setupItems.length === 0 ||
    isSetupComplete(setupItems) ||
    state?.audioActive ||
    state?.finalizing
  ) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $("pp-setup-list").innerHTML = setupItems
    .map(
      (item) => `
      <li class="pp-setup-item pp-setup-item--${item.state}">
        ${icon(setupIcon(item))}
        <div class="pp-setup-body">
          <div class="pp-setup-title">${escapeHtml(item.title)}</div>
          <div class="pp-setup-detail">${escapeHtml(item.detail)}</div>
        </div>
        ${
          item.state === "ok"
            ? ""
            : `<button class="vb-btn vb-btn--sm pp-setup-fix" type="button" data-anchor="${escapeHtml(item.anchor)}">${
                item.id === "microphone"
                  ? "Liberar"
                  : item.id === "valorbrain"
                    ? "Conectar"
                    : "Configurar"
              }</button>`
        }
      </li>`,
    )
    .join("");
  section.querySelectorAll<HTMLButtonElement>("[data-anchor]").forEach((btn) => {
    btn.addEventListener("click", () => openOptions(btn.dataset.anchor || ""));
  });
}

/**
 * "Versão X disponível" when the site has a newer version. Hidden while
 * recording or saving: updating the extension then would end the recording.
 */
function renderUpdate() {
  const latest = updateStatus?.latestVersion ?? "";
  const visible =
    updateStatus?.available === true &&
    compareVersions(latest, chrome.runtime.getManifest().version) > 0 &&
    !state?.audioActive &&
    !state?.finalizing;
  show("pp-update", visible);
  $("pp-update-text").textContent = visible ? `Versão ${latest} disponível` : "";
}

async function renderReadyMicWarning() {
  const permission = await getMicPermission();
  show("pp-mic-warning", permission === "prompt" || permission === "denied");
}

function render() {
  renderStatusLine();
  renderNotice(state?.notice);
  renderUpdate();

  const finalizing = state?.finalizing === true;
  const recording = !finalizing && state?.audioActive === true;
  const meetingHere = !finalizing && !recording && Boolean(activeMeetingId());
  const elsewhere =
    !finalizing &&
    !recording &&
    !meetingHere &&
    Boolean(state?.isActive && getMeetingIdFromUrl(state?.meetingUrl ?? undefined)) &&
    state?.targetTabId !== activeTab?.id;

  show("pp-finalizing", finalizing);
  show("pp-recording", recording);
  show("pp-ready", meetingHere);
  show("pp-elsewhere", elsewhere);
  show("pp-idle", !finalizing && !recording && !meetingHere && !elsewhere);

  if (recording) renderRecording();
  if (meetingHere) {
    $("pp-ready-meeting").textContent = activeMeetingId() || "";
    void renderReadyMicWarning();
  }
  if (elsewhere) $("pp-elsewhere-meeting").textContent = state?.meetingId || "";

  renderLastSession();
  renderSetup();

  if (recording && !timerHandle) {
    timerHandle = setInterval(() => {
      renderStatusLine();
      if (state?.audioActive && state.startTime) {
        $("pp-rec-timer").textContent = formatClock((Date.now() - state.startTime) / 1000);
      }
    }, 1000);
  } else if (!recording && timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

// ——— Actions ———

function getStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(
          new Error(
            "O Chrome não liberou a captura desta aba. Clique de novo no ícone do ValorBrain Meet com a aba da reunião aberta.",
          ),
        );
        return;
      }
      resolve(streamId);
    });
  });
}

async function startRecording(button: HTMLButtonElement, errorId: string) {
  const tab = activeTab;
  const errorEl = $(errorId);
  errorEl.hidden = true;
  if (!tab?.id) return;

  const label = button.querySelector(".pp-start-label") ?? button;
  const original = label.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  label.textContent = "Iniciando…";

  try {
    const streamId = await getStreamId(tab.id);
    const permission = await getMicPermission();
    const meetingId =
      getMeetingIdFromUrl(tab.url) || (tab.title || "Aba do navegador").slice(0, 80);
    const response = await chrome.runtime.sendMessage({
      type: "MANUAL_START_AUDIO",
      tabId: tab.id,
      meetingId,
      meetingUrl: tab.url || null,
      streamId,
      includeMicrophone: permission === "granted" || permission === "unknown",
    });
    if (!response?.success)
      throw new Error(response?.error || "Não foi possível iniciar a gravação.");
    state = (await chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => state)) ?? state;
    render();
  } catch (err) {
    errorEl.textContent = (err as Error)?.message || String(err);
    errorEl.hidden = false;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    label.textContent = original;
  }
}

async function stopRecording(button: HTMLButtonElement) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Encerrando…";
  await chrome.runtime.sendMessage({ type: "MANUAL_STOP_AUDIO" }).catch(() => {});
  // The service worker broadcasts `finalizing` right away; render it even if
  // the broadcast raced the response.
  if (state) state = { ...state, finalizing: true };
  render();
}

// ——— Data ———

async function loadLastSession() {
  const stored = await chrome.storage.local.get(LAST_SESSION_KEY);
  lastSession = (stored[LAST_SESSION_KEY] as LastSessionResult | undefined) ?? null;
}

async function loadUpdateStatus() {
  const stored = await chrome.storage.local.get(UPDATE_STATUS_KEY);
  updateStatus = (stored[UPDATE_STATUS_KEY] as UpdateStatus | undefined) ?? null;
}

async function loadSetup() {
  setupItems = await getSetupStatus({ probe: true }).catch(() => []);
  renderSetup();
  renderStatusLine();
}

/**
 * Footer hint with the shortcut Chrome really bound to "toggle-recording".
 * Chrome skips a suggested key that collides with its own accelerators and the
 * user may rebind it, so the binding is read at runtime, never hardcoded.
 */
async function renderShortcut() {
  const host = $("pp-shortcut");
  const commands = await chrome.commands.getAll().catch(() => []);
  const shortcut = commands.find((command) => command.name === "toggle-recording")?.shortcut ?? "";
  host.replaceChildren();
  if (shortcut) {
    shortcutKeys(shortcut).forEach((key, index) => {
      if (index > 0) host.append(" + ");
      const kbd = document.createElement("span");
      kbd.className = "vb-kbd";
      kbd.textContent = key;
      host.append(kbd);
    });
    host.append(" inicia ou encerra");
    return;
  }
  const link = document.createElement("button");
  link.type = "button";
  link.className = "pp-link";
  link.textContent = "Definir atalho de gravação";
  link.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    window.close();
  });
  host.append(link);
}

document.addEventListener("DOMContentLoaded", async () => {
  hydrateIcons();
  void renderShortcut();

  $("pp-open-settings").addEventListener("click", () => openOptions());
  $("pp-setup-open").addEventListener("click", () => openOptions());
  $("pp-open-panel").addEventListener("click", () => openSidePanel());
  $("pp-panel-secondary").addEventListener("click", () => openSidePanel("transcript"));
  $("pp-history").addEventListener("click", () => openSidePanel("history"));
  $("pp-grant-mic").addEventListener("click", () => openOptions("microfone"));
  $("pp-open-meet").addEventListener("click", () => {
    void chrome.tabs.create({ url: "https://meet.google.com/" });
    window.close();
  });
  $("pp-update-open").addEventListener("click", () => {
    void chrome.tabs.create({ url: UPDATE_PAGE_URL });
    window.close();
  });
  $("pp-go-meeting").addEventListener("click", async () => {
    if (typeof state?.targetTabId === "number") {
      const tab = await chrome.tabs.update(state.targetTabId, { active: true }).catch(() => null);
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
    }
  });
  $<HTMLButtonElement>("pp-start").addEventListener(
    "click",
    (e) => void startRecording(e.currentTarget as HTMLButtonElement, "pp-start-error"),
  );
  $<HTMLButtonElement>("pp-record-tab").addEventListener(
    "click",
    (e) => void startRecording(e.currentTarget as HTMLButtonElement, "pp-idle-error"),
  );
  $<HTMLButtonElement>("pp-stop").addEventListener(
    "click",
    (e) => void stopRecording(e.currentTarget as HTMLButtonElement),
  );

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const internalPage =
    !activeTab?.url || /^(chrome|edge|about|chrome-extension):/.test(activeTab.url);
  $("pp-record-tab").hidden = internalPage;

  await loadLastSession();
  await loadUpdateStatus();
  try {
    state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  } catch {
    state = null;
  }
  render();
  void loadSetup();
  // Checks only when due (once a day); a new result arrives through storage.
  void chrome.runtime.sendMessage({ type: "CHECK_FOR_UPDATE" }).catch(() => {});

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "STATE_UPDATE" && message.state) {
      state = message.state;
      render();
    } else if (message?.type === "SESSION_ENDED") {
      void loadLastSession().then(render);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[LAST_SESSION_KEY]) {
      lastSession = (changes[LAST_SESSION_KEY].newValue as LastSessionResult | undefined) ?? null;
      renderLastSession();
    }
    if (changes[UPDATE_STATUS_KEY]) {
      updateStatus = (changes[UPDATE_STATUS_KEY].newValue as UpdateStatus | undefined) ?? null;
      renderUpdate();
    }
    if (changes.settings || changes["provider.summary"] || changes["provider.transcription"]) {
      void loadSetup();
    }
  });
});

globalThis.addEventListener("unload", () => {
  if (timerHandle) clearInterval(timerHandle);
});
