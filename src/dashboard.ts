// Side panel: live meeting view (summary, transcript, decisions, people) and
// the local history of saved meetings with their ValorBrain delivery status.
import type { ActionItem, MeetingNotice, State, TranscriptEntry } from "./types";
import { initTheme } from "./theme";
import { hydrateIcons, icon, type IconName } from "./ui/icons";
import { escapeHtml } from "./utils/domHelpers";
import {
  confidenceLabel,
  consolidationLabel,
  formatClock,
  formatDateTime,
  formatDurationHuman,
  initials,
  plural,
  sentimentLabel,
  speakerLabel,
  topicStatusLabel,
} from "./ui/format";
import { getMeetingIdFromUrl } from "./meetingTabs";
import {
  buildMeetingJson,
  buildMeetingMarkdown,
  buildMeetingText,
  exportFilename,
  meetingTitle,
} from "./meetingExport";

void initTheme();

type TabName = "summary" | "transcript" | "actions" | "people" | "history";
const TABS: TabName[] = ["summary", "transcript", "actions", "people", "history"];
const DASHBOARD_TAB_KEY = "dashboardInitialTab";
const ACTION_STATUS_KEY = "actionItemStatuses";
const WAVE_BARS = 32;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let liveState: State | null = null;
let viewed: State | null = null;
let activeTab: TabName = "summary";
let timerHandle: ReturnType<typeof setInterval> | null = null;
let toastHandle: ReturnType<typeof setTimeout> | null = null;
let lastWaveAt = 0;
const actionStatuses = new Map<string, boolean>();

function current(): State | null {
  return viewed ?? liveState;
}

function toast(message: string, kind: "info" | "error" = "info") {
  const el = $("db-toast");
  el.textContent = message;
  el.className = `vb-toast${kind === "error" ? " vb-toast--error" : ""} is-visible`;
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.remove("is-visible"), 3200);
}

function emptyBlock(title: string, text = ""): string {
  return `<div class="db-empty"><strong>${escapeHtml(title)}</strong>${escapeHtml(text)}</div>`;
}

function tsButton(chunkId: string | undefined, label: string | undefined): string {
  if (!label) return "";
  const safe = escapeHtml(label);
  return chunkId
    ? `<button type="button" class="db-ts" data-chunk="${escapeHtml(chunkId)}" aria-label="Ir para ${safe} na transcrição">${safe}</button>`
    : `<span class="db-ts">${safe}</span>`;
}

function copyButton(text: string, label: string): string {
  return `<button type="button" class="vb-icon-btn db-copy" data-copy="${escapeHtml(text)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon("copy")}</button>`;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado.");
  } catch {
    toast("Não consegui copiar.", "error");
  }
}

// ——— Action item status (ticked checkboxes) ———

function statusKey(session: State | null, task: string): string {
  return `${session?.meetingId || "unknown"}::${session?.startTime || 0}::${task}`;
}

async function loadActionStatuses() {
  const stored = (await chrome.storage.local.get(ACTION_STATUS_KEY))[ACTION_STATUS_KEY];
  actionStatuses.clear();
  if (stored && typeof stored === "object") {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      actionStatuses.set(key, value === true);
    }
  }
}

async function saveActionStatus(key: string, done: boolean) {
  actionStatuses.set(key, done);
  await chrome.storage.local.set({ [ACTION_STATUS_KEY]: Object.fromEntries(actionStatuses) });
}

function isActionDone(session: State | null, task: string): boolean {
  return actionStatuses.get(statusKey(session, task)) === true;
}

// ——— Header / controls ———

function renderHeader() {
  const s = liveState;
  const chip = $("db-state-chip");
  const timer = $("db-timer");
  if (s?.finalizing) {
    chip.className = "vb-chip vb-chip--warning";
    chip.innerHTML = '<span class="vb-spinner" aria-hidden="true"></span>Salvando';
  } else if (s?.audioActive) {
    chip.className = "vb-chip vb-chip--error";
    chip.innerHTML = '<span class="vb-rec-dot"></span>Gravando';
  } else if (s?.isActive && getMeetingIdFromUrl(s.meetingUrl ?? undefined)) {
    chip.className = "vb-chip vb-chip--neutral";
    chip.textContent = "Pronta para gravar";
  } else {
    chip.className = "vb-chip vb-chip--neutral";
    chip.textContent = "Sem reunião";
  }

  const recording = s?.audioActive === true && !s.finalizing;
  timer.hidden = !recording;
  if (recording && s?.startTime) timer.textContent = formatClock((Date.now() - s.startTime) / 1000);

  if (recording && !timerHandle) {
    timerHandle = setInterval(() => {
      if (liveState?.audioActive && liveState.startTime) {
        timer.textContent = formatClock((Date.now() - liveState.startTime) / 1000);
      }
    }, 1000);
  } else if (!recording && timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function renderControls() {
  const label = $("db-meeting-label");
  const title = $("db-meeting-title");
  const button = $<HTMLButtonElement>("db-record-btn");
  const buttonLabel = button.querySelector(".db-record-label");

  if (viewed) {
    label.textContent = "Reunião salva";
    title.textContent = meetingTitle(viewed);
    button.hidden = true;
    return;
  }

  const s = liveState;
  const meetingId = getMeetingIdFromUrl(s?.meetingUrl ?? undefined);
  if (s?.finalizing) {
    label.textContent = "Salvando";
    title.textContent = meetingTitle(s);
    button.hidden = false;
    button.disabled = true;
    button.className = "vb-btn vb-btn--danger";
    if (buttonLabel) buttonLabel.textContent = "Salvando…";
  } else if (s?.audioActive) {
    label.textContent = "Gravando agora";
    title.textContent = s.currentTopic || meetingTitle(s);
    button.hidden = false;
    button.disabled = false;
    button.className = "vb-btn vb-btn--danger";
    if (buttonLabel) buttonLabel.textContent = "Encerrar e salvar";
    button.querySelector("svg")?.remove();
    button.insertAdjacentHTML("afterbegin", icon("stop"));
  } else if (s?.isActive && meetingId) {
    label.textContent = "Reunião detectada";
    title.textContent = meetingId;
    button.hidden = false;
    button.disabled = false;
    button.className = "vb-btn vb-btn--primary";
    if (buttonLabel) buttonLabel.textContent = "Iniciar gravação";
    button.querySelector("svg")?.remove();
    button.insertAdjacentHTML("afterbegin", icon("mic"));
  } else {
    label.textContent = "Reunião";
    title.textContent = "Nenhuma reunião aberta";
    button.hidden = true;
  }
}

function renderViewingBanner() {
  const banner = $("db-viewing");
  banner.hidden = !viewed;
  if (viewed) {
    const when = viewed.startTime || viewed.savedAt || 0;
    $("db-viewing-text").textContent =
      `Você está vendo uma reunião salva${when ? ` de ${formatDateTime(when)}` : ""}.`;
  }
}

function renderNotice(notice: MeetingNotice | null | undefined) {
  const host = $("db-notice");
  if (!notice || viewed) {
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

// ——— Summary tab ———

function renderAudioCard(s: State | null) {
  const card = $("db-audio-card");
  card.hidden = Boolean(viewed);
  if (viewed) return;
  const chip = $("db-audio-chip");
  const meta = $("db-audio-meta");
  const receiving = s?.audioActive && Date.now() - lastWaveAt < 1500;
  if (s?.audioActive) {
    chip.className = `vb-chip vb-card-aside ${receiving ? "vb-chip--success" : "vb-chip--neutral"}`;
    chip.innerHTML = receiving ? `${icon("activity")}Recebendo áudio` : "Aguardando áudio";
  } else {
    chip.className = "vb-chip vb-chip--neutral vb-card-aside";
    chip.textContent = s?.finalizing ? "Finalizando" : "Parada";
    drawIdleWave();
  }

  const parts: string[] = [];
  if (s?.audioActive || s?.finalizing) {
    parts.push(
      s?.micActive === false
        ? "Microfone fora da gravação: só o áudio da reunião."
        : "Áudio da reunião + seu microfone.",
    );
    const stats = s?.stats;
    if (stats) {
      parts.push(
        `${plural(stats.chunksTranscribed, "trecho transcrito", "trechos transcritos")}${
          stats.chunksFiltered ? ` · ${stats.chunksFiltered} sem fala` : ""
        }${stats.chunksFailed ? ` · ${stats.chunksFailed} com erro` : ""}`,
      );
    }
  } else {
    parts.push("A gravação usa o áudio da aba da reunião e o seu microfone.");
  }
  meta.textContent = parts.join(" ");
}

function renderSummaryTab(s: State | null) {
  renderAudioCard(s);

  const summaryEl = $("db-summary");
  const summary = s?.summary?.trim();
  if (summary) {
    summaryEl.classList.remove("vb-muted");
    summaryEl.textContent = summary;
  } else {
    summaryEl.classList.add("vb-muted");
    summaryEl.textContent =
      s?.audioActive || s?.finalizing
        ? "O resumo aparece alguns minutos depois que a conversa começa."
        : viewed
          ? "Esta reunião não tem resumo."
          : "Inicie a gravação para acompanhar o resumo ao vivo.";
  }

  const items = s?.summaryItems ?? [];
  const list = $("db-summary-items");
  list.hidden = items.length === 0;
  list.innerHTML = items
    .map(
      (item) =>
        `<li class="db-point"><span class="db-point-text">${escapeHtml(item.text)}</span>${tsButton(item.chunkId, item.timestampLabel || item.timestamp)}</li>`,
    )
    .join("");

  const counts = s?.truncatedCounts;
  $("db-stat-lines").textContent = String(counts?.transcript ?? s?.transcript?.length ?? 0);
  $("db-stat-topics").textContent = String(counts?.topics ?? s?.topics?.length ?? 0);
  $("db-stat-decisions").textContent = String(counts?.decisions ?? s?.decisions?.length ?? 0);
  $("db-stat-actions").textContent = String(counts?.actionItems ?? s?.actionItems?.length ?? 0);

  const currentTopic = $("db-current-topic");
  currentTopic.hidden = !s?.currentTopic || Boolean(viewed);
  currentTopic.innerHTML = s?.currentTopic
    ? `${icon("target")}<span>Agora: ${escapeHtml(s.currentTopic)}</span>`
    : "";

  const topics = s?.topics ?? [];
  $("db-topics").innerHTML = topics.length
    ? topics
        .map((t) => {
          const chipClass =
            t.status === "completed"
              ? "vb-chip--success"
              : t.status === "unresolved"
                ? "vb-chip--warning"
                : "vb-chip--info";
          return `<li class="db-item"><div class="db-item-body"><div class="db-item-text">${escapeHtml(t.name)}</div></div><span class="vb-chip ${chipClass}">${escapeHtml(topicStatusLabel(t.status))}</span></li>`;
        })
        .join("")
    : `<li>${emptyBlock("Nenhum assunto ainda", "")}</li>`;

  const groups: Array<{ title: string; items: string[] }> = [
    {
      title: "Principais pontos",
      items: (s?.keyInsights ?? [])
        .map((i) => (typeof i === "string" ? i : i?.text))
        .filter(Boolean) as string[],
    },
    { title: "Pontos em aberto", items: (s?.unresolvedDiscussions ?? []).filter(Boolean) },
    { title: "Perguntas sem resposta", items: (s?.questionsRaised ?? []).filter(Boolean) },
    {
      title: "Contradições",
      items: (s?.contradictions ?? [])
        .map((c) => (typeof c === "string" ? c : c?.issue))
        .filter(Boolean) as string[],
    },
  ].filter((group) => group.items.length > 0);
  $("db-highlights").innerHTML = groups.length
    ? groups
        .map(
          (group) =>
            `<div class="db-highlight-group"><h3>${escapeHtml(group.title)}</h3><ul>${group.items
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join("")}</ul></div>`,
        )
        .join("")
    : emptyBlock("Nada destacado ainda", "Insights, perguntas e pontos em aberto aparecem aqui.");

  const sentiment = String(s?.sentiment || "neutral").toLowerCase();
  const widths: Record<string, string> = {
    positive: "85%",
    neutral: "50%",
    mixed: "55%",
    negative: "20%",
  };
  const fill = $("db-sentiment-fill");
  fill.style.width = widths[sentiment] ?? "50%";
  fill.dataset.sentiment = sentiment;
  $("db-sentiment-label").textContent = sentimentLabel(sentiment);

  // What the review at the end changed (the document sent to ValorBrain never says it).
  const reviewLabel = consolidationLabel(s?.consolidation);
  $("db-consolidation-text").textContent = reviewLabel;
  $("db-consolidation").hidden = !reviewLabel;
  // A saved meeting reviewed by the model can get its lists from before back.
  $("db-undo-review").hidden =
    !viewed || !s?.consolidation?.original || s.consolidation.undone === true;

  const tokens = s?.tokensUsed ?? 0;
  const cost = s?.estimatedCost ?? 0;
  $("db-usage").textContent =
    tokens > 0
      ? `IA nesta reunião: ${tokens.toLocaleString("pt-BR")} tokens${cost > 0 ? ` · US$ ${cost.toFixed(4)}` : ""}`
      : "";
}

// ——— Transcript tab ———

let renderedTranscriptKey = "";
let renderedTranscriptCount = 0;

function transcriptKey(s: State | null): string {
  return viewed ? `saved:${viewed.id}` : `live:${s?.startTime ?? 0}`;
}

function transcriptLineHtml(entry: TranscriptEntry): string {
  const label = entry.timestampLabel || formatClock(entry.timestamp || 0);
  const speaker = speakerLabel(entry.speaker);
  const id = entry.id ? `tr-${escapeHtml(entry.id)}` : "";
  return `
    <div class="db-line"${id ? ` id="${id}"` : ""}>
      <div class="db-avatar" aria-hidden="true">${escapeHtml(initials(entry.speaker))}</div>
      <div class="db-line-body">
        <div class="db-line-head"><span class="db-line-speaker">${escapeHtml(speaker)}</span><span class="db-ts">${escapeHtml(label)}</span></div>
        <div class="db-line-text">${escapeHtml(entry.text)}</div>
      </div>
      ${copyButton(`[${label}] ${speaker}: ${entry.text}`, "Copiar esta fala")}
    </div>`;
}

function renderTranscriptTab(s: State | null) {
  const container = $("db-transcript");
  const entries = s?.transcript ?? [];
  const key = transcriptKey(s);

  if (entries.length === 0) {
    renderedTranscriptKey = key;
    renderedTranscriptCount = 0;
    container.innerHTML = emptyBlock(
      s?.audioActive ? "Aguardando a primeira fala" : "Sem transcrição",
      s?.audioActive ? "As falas aparecem aqui poucos segundos depois de ditas." : "",
    );
    return;
  }

  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  if (key !== renderedTranscriptKey || entries.length < renderedTranscriptCount) {
    container.innerHTML = entries.map(transcriptLineHtml).join("");
  } else if (entries.length > renderedTranscriptCount) {
    container.querySelector(".db-empty")?.remove();
    container.insertAdjacentHTML(
      "beforeend",
      entries.slice(renderedTranscriptCount).map(transcriptLineHtml).join(""),
    );
  } else {
    return;
  }
  renderedTranscriptKey = key;
  renderedTranscriptCount = entries.length;

  if (searchInput().value.trim()) runSearch(true);
  else if (activeTab === "transcript" && nearBottom && !viewed)
    window.scrollTo({ top: document.body.scrollHeight });
}

function navigateToChunk(chunkId: string) {
  selectTab("transcript");
  const target = document.getElementById(`tr-${chunkId}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("is-highlighted");
  setTimeout(() => target.classList.remove("is-highlighted"), 2500);
}

// ——— Search ———

let matches: HTMLElement[] = [];
let matchIndex = -1;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

const searchInput = () => $<HTMLInputElement>("db-search");

function clearMarks() {
  $("db-transcript")
    .querySelectorAll("mark.db-match")
    .forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    });
}

function updateSearchControls() {
  $("db-search-count").textContent = matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0";
  $<HTMLButtonElement>("db-search-prev").disabled = matches.length === 0;
  $<HTMLButtonElement>("db-search-next").disabled = matches.length === 0;
}

function focusMatch(scroll = true) {
  matches.forEach((mark, i) => mark.classList.toggle("is-current", i === matchIndex));
  updateSearchControls();
  if (scroll) matches[matchIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function runSearch(preserveIndex = false) {
  const query = searchInput().value.trim().toLowerCase();
  const previous = matchIndex;
  clearMarks();
  matches = [];
  matchIndex = -1;
  if (!query) {
    updateSearchControls();
    return;
  }
  const walker = document.createTreeWalker($("db-transcript"), NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(".db-line-text") && node.nodeValue?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);

  for (const node of nodes) {
    const text = node.nodeValue || "";
    const lower = text.toLowerCase();
    let at = lower.indexOf(query);
    if (at === -1) continue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    while (at !== -1) {
      if (at > last) fragment.appendChild(document.createTextNode(text.slice(last, at)));
      const mark = document.createElement("mark");
      mark.className = "db-match";
      mark.textContent = text.slice(at, at + query.length);
      fragment.appendChild(mark);
      matches.push(mark);
      last = at + query.length;
      at = lower.indexOf(query, last);
    }
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(fragment, node);
  }
  if (matches.length) {
    matchIndex = preserveIndex && previous >= 0 && previous < matches.length ? previous : 0;
    focusMatch(!preserveIndex);
  } else {
    updateSearchControls();
  }
}

function stepMatch(direction: 1 | -1) {
  if (!matches.length) return;
  matchIndex = (matchIndex + direction + matches.length) % matches.length;
  focusMatch();
}

// ——— Decisions & actions tab ———

function renderActionsTab(s: State | null) {
  const decisions = (s?.decisions ?? []).filter((d) => d?.text);
  $("db-decisions").innerHTML = decisions.length
    ? decisions
        .map((d) => {
          const meta = [
            d.by ? `<span>${escapeHtml(d.by)}</span>` : "",
            d.classification === "tentative"
              ? `<span class="vb-chip vb-chip--warning">${icon("alertTriangle")}A confirmar</span>`
              : "",
            tsButton(d.chunkId, d.timestampLabel || d.timestamp),
          ].filter(Boolean);
          return `<li class="db-item">
            <div class="db-item-body">
              <div class="db-item-text">${escapeHtml(d.text)}</div>
              ${meta.length ? `<div class="db-item-meta">${meta.join("")}</div>` : ""}
            </div>
            ${copyButton(d.by ? `${d.text} (${d.by})` : d.text, "Copiar decisão")}
          </li>`;
        })
        .join("")
    : `<li>${emptyBlock("Nenhuma decisão registrada", "")}</li>`;

  const actions = (s?.actionItems ?? []).filter((a: ActionItem) => a?.task);
  $("db-actions").innerHTML = actions.length
    ? actions
        .map((a, index) => {
          const done = isActionDone(s, a.task);
          const meta = [
            a.owner ? `<span>${icon("users")}${escapeHtml(a.owner)}</span>` : "",
            a.deadline ? `<span>${icon("clock")}${escapeHtml(a.deadline)}</span>` : "",
            a.isSpeculative
              ? `<span class="vb-chip vb-chip--neutral">Ideia, não confirmada</span>`
              : "",
            a.confidence && a.confidence !== "high"
              ? `<span class="vb-chip vb-chip--neutral">Confiança ${escapeHtml(confidenceLabel(a.confidence))}</span>`
              : "",
            tsButton(a.chunkId, a.timestampLabel || a.timestamp),
          ].filter(Boolean);
          const copy = `- [${done ? "x" : " "}] ${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.deadline ? ` (prazo: ${a.deadline})` : ""}`;
          return `<li class="db-item${done ? " db-item--done" : ""}">
            <input type="checkbox" class="db-check" id="act-${index}" data-task="${escapeHtml(a.task)}" ${done ? "checked" : ""} aria-label="Marcar como feito: ${escapeHtml(a.task)}" />
            <label class="db-item-body" for="act-${index}">
              <div class="db-item-text">${escapeHtml(a.task)}</div>
              ${meta.length ? `<div class="db-item-meta">${meta.join("")}</div>` : ""}
            </label>
            ${copyButton(copy, "Copiar próximo passo")}
          </li>`;
        })
        .join("")
    : `<li>${emptyBlock("Nenhum próximo passo registrado", "")}</li>`;
}

// ——— People tab ———

function renderPeopleTab(s: State | null) {
  const late = new Set(s?.lateJoiners ?? []);
  const people = Array.from(new Set((s?.participants ?? []).filter((p) => p && p !== "You")));
  $("db-people").innerHTML = people.length
    ? people
        .map(
          (name) => `<li class="db-item">
            <div class="db-avatar" aria-hidden="true">${escapeHtml(initials(name))}</div>
            <div class="db-item-body"><div class="db-item-text">${escapeHtml(name)}</div></div>
            ${late.has(name) ? `<span class="vb-chip vb-chip--info">Entrou depois</span>` : ""}
          </li>`,
        )
        .join("")
    : `<li>${emptyBlock("Nenhum participante detectado", "Os nomes aparecem conforme o Meet mostra quem está na sala.")}</li>`;

  const events = s?.timeline ?? [];
  $("db-timeline").innerHTML = events.length
    ? events
        .map(
          (event) =>
            `<li><span class="db-ts">${escapeHtml(formatClock(event.elapsed || 0))}</span><span>${escapeHtml(event.event)}</span></li>`,
        )
        .join("")
    : `<li>${emptyBlock("Nenhum evento ainda", "")}</li>`;
}

// ——— History tab ———

function vbChip(session: State): string {
  const vb = session.vb;
  if (vb?.status === "sent")
    return `<span class="vb-chip vb-chip--success">${icon("checkCircle")}No ValorBrain</span>`;
  if (vb?.status === "failed")
    return `<span class="vb-chip vb-chip--error">${icon("alertCircle")}Envio falhou</span>`;
  return `<span class="vb-chip vb-chip--neutral">Só neste navegador</span>`;
}

async function renderHistory() {
  const container = $("db-history");
  let sessions: State[];
  try {
    sessions = (await chrome.runtime.sendMessage({ type: "GET_SAVED_SESSIONS" })) ?? [];
  } catch {
    sessions = [];
  }
  if (!Array.isArray(sessions) || sessions.length === 0) {
    container.innerHTML = emptyBlock(
      "Nenhuma reunião salva ainda",
      "Toda gravação encerrada é salva aqui automaticamente.",
    );
    return;
  }

  container.innerHTML = sessions
    .map((session) => {
      const when = session.startTime || session.savedAt || 0;
      const counts = [
        session.duration ? formatDurationHuman(session.duration) : "",
        plural(session.decisions?.length ?? 0, "decisão", "decisões"),
        plural(session.actionItems?.length ?? 0, "ação", "ações"),
      ].filter(Boolean);
      const sent = session.vb?.status === "sent";
      return `<article class="vb-card db-session" data-session="${escapeHtml(session.id || "")}">
        <div class="db-session-head">
          <div>
            <div class="db-session-title">${escapeHtml(meetingTitle(session))}</div>
            <div class="db-session-meta">${escapeHtml([formatDateTime(when), ...counts].filter(Boolean).join(" · "))}</div>
          </div>
          ${vbChip(session)}
        </div>
        ${session.summary ? `<p class="db-session-summary">${escapeHtml(session.summary)}</p>` : ""}
        ${session.vb?.status === "failed" && session.vb.error ? `<p class="db-session-error">${escapeHtml(session.vb.error)}</p>` : ""}
        <div class="db-session-actions">
          <button type="button" class="vb-btn vb-btn--sm" data-act="open">${icon("fileText")}Abrir</button>
          <button type="button" class="vb-btn vb-btn--sm${sent ? "" : " vb-btn--primary"}" data-act="send">${icon("cloudUpload")}${sent ? "Reenviar" : "Enviar ao ValorBrain"}</button>
          <button type="button" class="vb-btn vb-btn--sm" data-act="download">${icon("download")}.md</button>
          <button type="button" class="vb-btn vb-btn--sm vb-btn--ghost" data-act="delete" aria-label="Excluir esta reunião">${icon("trash")}</button>
        </div>
      </article>`;
    })
    .join("");
}

async function loadSavedSession(sessionId: string): Promise<State | null> {
  try {
    const session = await chrome.runtime.sendMessage({ type: "GET_SAVED_SESSION", sessionId });
    if (!session) toast("Não encontrei esta reunião no histórico.", "error");
    return session ?? null;
  } catch (err) {
    toast(`Não consegui abrir a reunião: ${(err as Error)?.message || err}`, "error");
    return null;
  }
}

async function handleHistoryAction(button: HTMLButtonElement) {
  const card = button.closest<HTMLElement>("[data-session]");
  const sessionId = card?.dataset.session;
  if (!sessionId) return;
  const action = button.dataset.act;

  if (action === "open") {
    const session = await loadSavedSession(sessionId);
    if (!session) return;
    viewed = session;
    renderAll();
    selectTab("summary");
    window.scrollTo({ top: 0 });
  } else if (action === "download") {
    const session = await loadSavedSession(sessionId);
    if (session)
      download(
        buildMeetingMarkdown(session, { isActionDone: (t) => isActionDone(session, t) }),
        exportFilename(session, "md"),
        "text/markdown",
      );
  } else if (action === "send") {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Enviando…";
    const result = await chrome.runtime
      .sendMessage({ type: "VB_SEND_SESSION", sessionId })
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (result?.ok) toast("Reunião enviada ao ValorBrain.");
    else toast(`O envio falhou: ${result?.error || "erro desconhecido"}`, "error");
    await renderHistory();
  } else if (action === "delete") {
    const dialog = $<HTMLDialogElement>("db-delete-dialog");
    dialog.returnValue = "";
    dialog.showModal();
    dialog.addEventListener(
      "close",
      async () => {
        if (dialog.returnValue !== "confirm") return;
        await chrome.runtime.sendMessage({ type: "DELETE_SAVED_SESSION", sessionId });
        if (viewed?.id === sessionId) viewed = null;
        toast("Reunião excluída do histórico.");
        renderAll();
        await renderHistory();
      },
      { once: true },
    );
  }
}

/** Puts back the lists the review changed in the saved meeting being viewed. */
async function undoRecordReview(button: HTMLButtonElement) {
  const sessionId = viewed?.id;
  if (!sessionId) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await chrome.runtime.sendMessage({ type: "UNDO_RECORD_REVIEW", sessionId });
    if (!result?.success || !result.session) {
      throw new Error(result?.error || "erro desconhecido");
    }
    if (viewed?.id === sessionId) viewed = result.session as State;
    renderAll();
    // The memory has the reviewed record until the meeting is sent again.
    toast(
      `Use ${result.session.vb?.status === "sent" ? "Reenviar" : "Enviar ao ValorBrain"} no Histórico para atualizar a memória.`,
    );
  } catch (err) {
    toast(`Não consegui desfazer a revisão: ${(err as Error)?.message || err}`, "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

// ——— Export ———

function download(content: string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Baixado: ${filename}`);
}

async function exportCurrent(kind: string) {
  let session: State | null = viewed;
  if (!session) {
    session = await chrome.runtime.sendMessage({ type: "GET_FULL_STATE" }).catch(() => null);
  }
  if (!session || ((session.transcript?.length ?? 0) === 0 && !session.summary)) {
    toast("Não há conteúdo para exportar. Abra uma reunião do histórico ou grave uma.", "error");
    return;
  }
  const options = { isActionDone: (task: string) => isActionDone(session, task) };
  if (kind === "md")
    download(
      buildMeetingMarkdown(session, options),
      exportFilename(session, "md"),
      "text/markdown",
    );
  else if (kind === "txt")
    download(buildMeetingText(session, options), exportFilename(session, "txt"), "text/plain");
  else if (kind === "json")
    download(buildMeetingJson(session), exportFilename(session, "json"), "application/json");
  else if (kind === "copy") await copyText(buildMeetingMarkdown(session, options));
}

// ——— Waveform ———

let waveCtx: CanvasRenderingContext2D | null = null;
let waveWidth = 300;
const WAVE_HEIGHT = 44;
let smoothed = new Array(WAVE_BARS).fill(0);

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function initWave() {
  const canvas = $<HTMLCanvasElement>("db-waveform");
  waveCtx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  waveWidth = canvas.offsetWidth || 300;
  canvas.width = Math.round(waveWidth * dpr);
  canvas.height = Math.round(WAVE_HEIGHT * dpr);
  waveCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawIdleWave();
}

function drawBars(values: number[], color: string) {
  if (!waveCtx) return;
  const gap = 3;
  const barWidth = Math.max(2, (waveWidth - gap * (WAVE_BARS - 1)) / WAVE_BARS);
  waveCtx.clearRect(0, 0, waveWidth, WAVE_HEIGHT);
  waveCtx.fillStyle = color;
  for (let i = 0; i < WAVE_BARS; i++) {
    const height = Math.max(3, values[i] * WAVE_HEIGHT * 0.95);
    waveCtx.globalAlpha = values[i] > 0.02 ? Math.min(1, 0.45 + values[i]) : 0.35;
    waveCtx.beginPath();
    waveCtx.roundRect(
      i * (barWidth + gap),
      (WAVE_HEIGHT - height) / 2,
      barWidth,
      height,
      barWidth / 2,
    );
    waveCtx.fill();
  }
  waveCtx.globalAlpha = 1;
}

function drawIdleWave() {
  smoothed = new Array(WAVE_BARS).fill(0);
  drawBars(smoothed, cssVar("--vb-border-control", "#9DA39E"));
}

function drawWave(buckets: number[]) {
  for (let i = 0; i < WAVE_BARS; i++) smoothed[i] = smoothed[i] * 0.55 + (buckets[i] || 0) * 0.45;
  drawBars(smoothed, cssVar("--vb-green", "#3F9E5E"));
}

// ——— Recording control ———

function getStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(
          new Error(
            "O Chrome só libera a captura depois que você clica no ícone do ValorBrain Meet na aba da reunião. Clique no ícone e em Iniciar gravação.",
          ),
        );
        return;
      }
      resolve(streamId);
    });
  });
}

async function toggleRecording(button: HTMLButtonElement) {
  if (liveState?.audioActive) {
    button.disabled = true;
    await chrome.runtime.sendMessage({ type: "MANUAL_STOP_AUDIO" }).catch(() => {});
    return;
  }
  const tabId = liveState?.targetTabId;
  if (typeof tabId !== "number") return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const streamId = await getStreamId(tabId);
    let micGranted = true;
    try {
      const permission = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      micGranted = permission.state === "granted";
    } catch {
      micGranted = true;
    }
    const response = await chrome.runtime.sendMessage({
      type: "MANUAL_START_AUDIO",
      tabId,
      meetingId: liveState?.meetingId,
      meetingUrl: liveState?.meetingUrl,
      streamId,
      includeMicrophone: micGranted,
    });
    if (!response?.success)
      throw new Error(response?.error || "Não foi possível iniciar a gravação.");
  } catch (err) {
    toast((err as Error)?.message || String(err), "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

// ——— Tabs ———

function selectTab(name: TabName) {
  activeTab = name;
  for (const tab of TABS) {
    const button = $(`tabbtn-${tab}`);
    const panel = $(`tab-${tab}`);
    const selected = tab === name;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
    panel.classList.toggle("is-active", selected);
  }
  if (name === "history") void renderHistory();
}

// ——— Render all ———

function renderAll() {
  const s = current();
  renderHeader();
  renderControls();
  renderViewingBanner();
  renderNotice(liveState?.notice);
  renderSummaryTab(s);
  renderTranscriptTab(s);
  renderActionsTab(s);
  renderPeopleTab(s);
}

document.addEventListener("DOMContentLoaded", async () => {
  hydrateIcons();
  initWave();
  window.addEventListener("resize", initWave);

  document.querySelectorAll<HTMLButtonElement>(".db-tab").forEach((button, index, all) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab as TabName));
    button.addEventListener("keydown", (event) => {
      const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
      if (event.key in keys) {
        event.preventDefault();
        const next = all[(index + keys[event.key] + all.length) % all.length];
        next.focus();
        next.click();
      }
    });
  });

  document.body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const ts = target.closest<HTMLButtonElement>("button.db-ts[data-chunk]");
    if (ts?.dataset.chunk) {
      navigateToChunk(ts.dataset.chunk);
      return;
    }
    const copy = target.closest<HTMLButtonElement>("[data-copy]");
    if (copy) {
      void copyText(copy.dataset.copy || "");
      return;
    }
    const historyButton = target.closest<HTMLButtonElement>("#db-history [data-act]");
    if (historyButton) void handleHistoryAction(historyButton);
  });

  $("db-actions").addEventListener("change", (event) => {
    const checkbox = event.target as HTMLInputElement;
    if (!checkbox.matches(".db-check")) return;
    const task = checkbox.dataset.task || "";
    checkbox.closest(".db-item")?.classList.toggle("db-item--done", checkbox.checked);
    void saveActionStatus(statusKey(current(), task), checkbox.checked);
  });

  $<HTMLButtonElement>("db-record-btn").addEventListener(
    "click",
    (event) => void toggleRecording(event.currentTarget as HTMLButtonElement),
  );
  $("db-back-live").addEventListener("click", () => {
    viewed = null;
    renderAll();
  });
  $<HTMLButtonElement>("db-undo-review").addEventListener(
    "click",
    (event) => void undoRecordReview(event.currentTarget as HTMLButtonElement),
  );
  $("db-copy-summary").addEventListener("click", () => {
    const summary = current()?.summary?.trim();
    if (summary) void copyText(summary);
    else toast("Ainda não há resumo para copiar.", "error");
  });

  // Search
  searchInput().addEventListener("input", () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(false), 150);
  });
  searchInput().addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      stepMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      searchInput().value = "";
      runSearch();
    }
  });
  $("db-search-prev").addEventListener("click", () => stepMatch(-1));
  $("db-search-next").addEventListener("click", () => stepMatch(1));
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      selectTab("transcript");
      searchInput().focus();
      searchInput().select();
    }
  });

  // Export menu
  const exportButton = $<HTMLButtonElement>("db-export-btn");
  const exportMenu = $("db-export-menu");
  const closeMenu = () => {
    exportMenu.hidden = true;
    exportButton.setAttribute("aria-expanded", "false");
  };
  exportButton.addEventListener("click", () => {
    const open = exportMenu.hidden;
    exportMenu.hidden = !open;
    exportButton.setAttribute("aria-expanded", String(open));
    if (open) exportMenu.querySelector<HTMLButtonElement>("button")?.focus();
  });
  exportMenu.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-export]");
    if (!item) return;
    closeMenu();
    void exportCurrent(item.dataset.export || "md");
  });
  exportMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      exportButton.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest(".db-export")) closeMenu();
  });

  await loadActionStatuses();
  try {
    liveState = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  } catch {
    liveState = null;
  }
  renderAll();

  const initial = (await chrome.storage.local.get(DASHBOARD_TAB_KEY))[DASHBOARD_TAB_KEY] as
    | TabName
    | undefined;
  if (initial && TABS.includes(initial)) {
    selectTab(initial);
    void chrome.storage.local.remove(DASHBOARD_TAB_KEY);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "STATE_UPDATE" && message.state) {
      liveState = message.state;
      if (viewed) {
        renderHeader();
        renderControls();
      } else {
        renderAll();
      }
    } else if (message?.type === "WAVEFORM_DATA" && Array.isArray(message.buckets)) {
      const wasReceiving = Date.now() - lastWaveAt < 1500;
      lastWaveAt = Date.now();
      if (!viewed) {
        drawWave(message.buckets);
        if (!wasReceiving) renderAudioCard(liveState);
      }
    } else if (message?.type === "SESSION_ENDED") {
      if (message.saved) toast("Reunião salva. Ela está no Histórico.");
      if (activeTab === "history") void renderHistory();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.savedSessionIndex && activeTab === "history") void renderHistory();
    if (changes[ACTION_STATUS_KEY])
      void loadActionStatuses().then(() => renderActionsTab(current()));
  });

  // Keep the audio chip honest when the waveform stream stops.
  setInterval(() => {
    if (!viewed && liveState?.audioActive) renderAudioCard(liveState);
  }, 2000);
});
