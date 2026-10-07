// Options page: providers, ValorBrain connection, microphone, features, data.
// Every write merges into the freshly read `settings` object, so actions that
// save immediately (connect/disconnect) never clobber other fields.
import { applyTheme, initTheme } from "./theme";
import { hydrateIcons, icon, type IconName } from "./ui/icons";
import { escapeHtml } from "./utils/domHelpers";
import { hostOf, maskSecret } from "./ui/format";
import { getSettings } from "./settings";
import { DEFAULT_TRANSCRIPTION_LANGUAGE } from "./config";
import {
  getProviderConfig,
  getProviderProfile,
  normalizeProviderConfig,
  profileModel,
  profilesForRole,
  requiresApiKey,
  saveProviderConfig,
  type ProviderConfig,
  type ProviderRole,
} from "./utils/providerSettings";
import { validateApiUrl } from "./utils/urlValidator";
import { probeChat, probeTranscription } from "./providerClient";
import { describeProviderError } from "./providerErrors";
import { getMicPermission, getSetupStatus, isSetupComplete, type SetupItem } from "./setupStatus";
import {
  microphoneErrorCode,
  platformOs,
  SYSTEM_DENIED,
  systemMicrophoneHelp,
} from "./microphoneErrors";
import { isVbConfigured, normalizeVbSettings, testValorBrainConnection } from "./vbClient";
import { connectValorBrain, VB_API_BASE_URL } from "./vbConnect";
import { renderStorageDashboard } from "./storageDashboard";
import { DEFAULT_RECORDING_NOTICE, RECORDING_NOTICE_MAX_CHARS } from "./recordingNotice";
import { renderApiUsageDashboard } from "./apiUsageDashboard";
import { isVaultInitialized, unlockCredentials } from "./utils/credentials";

void initTheme();

type Settings = Record<string, unknown>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

/** Hosts already granted by the manifest (no runtime permission prompt needed). */
const MANIFEST_HOSTS = [
  /^https:\/\/api\.openai\.com$/,
  /^https:\/\/api\.z\.ai$/,
  /^https:\/\/([a-z0-9-]+\.)*valor\.digital$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

const TOGGLES: Array<{ id: string; key: string; defaultOn: boolean }> = [
  { id: "topic-toggle", key: "topicDetection", defaultOn: true },
  { id: "decision-toggle", key: "decisionDetection", defaultOn: true },
  { id: "action-toggle", key: "actionExtraction", defaultOn: true },
  { id: "sentiment-toggle", key: "sentimentAnalysis", defaultOn: true },
  { id: "consolidation-toggle", key: "recordConsolidation", defaultOn: true },
  { id: "refinement-toggle", key: "transcriptRefinement", defaultOn: false },
  { id: "late-joiner-toggle", key: "lateJoinerBriefing", defaultOn: true },
  { id: "public-late-joiner-chat-toggle", key: "publicLateJoinerChat", defaultOn: false },
  { id: "recording-notice-toggle", key: "recordingChatNotice", defaultOn: false },
  { id: "vb-graph-vocabulary", key: "graphVocabulary", defaultOn: true },
  { id: "vb-learn-corrections", key: "learnCorrections", defaultOn: true },
];

let dirty = false;
let toastHandle: ReturnType<typeof setTimeout> | null = null;
const profileOf: Record<ProviderRole, string> = { transcription: "", summary: "" };

function toast(message: string, kind: "info" | "error" = "info") {
  const el = $("op-toast");
  el.textContent = message;
  el.className = `vb-toast${kind === "error" ? " vb-toast--error" : ""} is-visible`;
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.remove("is-visible"), 3600);
}

function setStatus(
  id: string,
  kind: "success" | "error" | "warning" | "pending" | "",
  message: string,
) {
  const el = $(id);
  const iconName: Record<string, IconName> = {
    success: "checkCircle",
    error: "alertCircle",
    warning: "alertTriangle",
  };
  el.className = `op-test-status${kind ? ` is-${kind}` : ""}`;
  if (!message) {
    el.innerHTML = "";
    return;
  }
  const lead =
    kind === "pending"
      ? '<span class="vb-spinner" aria-hidden="true"></span>'
      : kind && iconName[kind]
        ? icon(iconName[kind])
        : "";
  el.innerHTML = `${lead}<span>${escapeHtml(message)}</span>`;
}

function markDirty(value = true) {
  dirty = value;
  $("op-savebar").hidden = !value;
}

async function readSettings(): Promise<Settings> {
  return (await getSettings()) as Settings;
}

async function patchSettings(patch: Settings, removeKeys: string[] = []) {
  const stored = (await chrome.storage.local.get("settings")).settings as Settings | undefined;
  const next: Settings = { ...(stored ?? {}), ...patch };
  for (const key of removeKeys) delete next[key];
  await chrome.storage.local.set({ settings: next });
}

// ——— Providers ———

function fieldId(role: ProviderRole, field: string) {
  return `${role}-${field}`;
}

function populateProfileSelect(role: ProviderRole) {
  const select = $<HTMLSelectElement>(fieldId(role, "profile"));
  select.innerHTML = [
    ...profilesForRole(role).map(
      (profile) => `<option value="${profile.id}">${escapeHtml(profile.label)}</option>`,
    ),
    `<option value="custom">Personalizado (compatível com OpenAI)</option>`,
  ].join("");
}

function describeProfile(role: ProviderRole, profileId: string) {
  const profile = getProviderProfile(profileId);
  $(fieldId(role, "profile-hint")).textContent = profile
    ? profile.description
    : "Qualquer endpoint no formato da API da OpenAI. Informe o endereço, a chave (se houver) e o modelo.";

  const keyHint = $(fieldId(role, "key-hint"));
  if (profileId === "zai-coding")
    keyHint.textContent = "Obrigatória. Use a chave do GLM Coding Plan (z.ai → API Keys).";
  else if (profileId === "zai")
    keyHint.textContent = "Obrigatória. Chave com saldo na API padrão da Z.ai.";
  else if (profileId === "whisper-valor")
    keyHint.textContent = "Obrigatória. É a chave Bearer configurada no servidor Whisper.";
  else if (profile?.requiresKey) keyHint.textContent = "Obrigatória para este provedor.";
  else keyHint.textContent = "Opcional. Deixe vazio para servidores sem autenticação.";
}

function readProviderFields(role: ProviderRole): ProviderConfig {
  return normalizeProviderConfig(role, {
    profile: $<HTMLSelectElement>(fieldId(role, "profile")).value,
    baseUrl: input(fieldId(role, "base-url")).value,
    apiKey: input(fieldId(role, "api-key")).value,
    model: input(fieldId(role, "model")).value,
  });
}

function writeProviderFields(role: ProviderRole, config: ProviderConfig) {
  $<HTMLSelectElement>(fieldId(role, "profile")).value = config.profile;
  input(fieldId(role, "base-url")).value = config.baseUrl;
  input(fieldId(role, "api-key")).value = config.apiKey;
  input(fieldId(role, "model")).value = config.model;
  profileOf[role] = config.profile;
  describeProfile(role, config.profile);
}

function onProfileChange(role: ProviderRole) {
  const select = $<HTMLSelectElement>(fieldId(role, "profile"));
  const next = getProviderProfile(select.value);
  const previous = getProviderProfile(profileOf[role]);
  if (next) {
    input(fieldId(role, "base-url")).value = next.baseUrl;
    input(fieldId(role, "model")).value = profileModel(next, role);
    // A key for another host would only produce 401s: clear it.
    const sameVendor =
      previous &&
      hostOf(previous.baseUrl).split(".").slice(-2).join(".") ===
        hostOf(next.baseUrl).split(".").slice(-2).join(".");
    if (!sameVendor) input(fieldId(role, "api-key")).value = "";
  }
  profileOf[role] = select.value;
  describeProfile(role, select.value);
  setStatus(fieldId(role, "test-status"), "", "");
}

async function runProviderTest(role: ProviderRole) {
  const statusId = fieldId(role, "test-status");
  const config = readProviderFields(role);
  const check = validateApiUrl(config.baseUrl);
  if (!check.valid) {
    setStatus(
      statusId,
      "error",
      "Endereço inválido. Use https:// (http:// só para localhost ou rede local).",
    );
    return;
  }
  const key = config.apiKey || null;
  if (requiresApiKey(config) && !key) {
    setStatus(statusId, "error", "Informe a chave de API antes de testar.");
    return;
  }
  const button = $<HTMLButtonElement>(fieldId(role, "test"));
  button.disabled = true;
  setStatus(
    statusId,
    "pending",
    role === "transcription"
      ? "Enviando um segundo de áudio de teste…"
      : "Pedindo uma resposta curta ao modelo…",
  );
  const started = performance.now();
  try {
    if (role === "transcription") {
      try {
        await probeTranscription(config, key);
      } catch (err) {
        // A socket-activated local server may refuse the very first connection.
        if (!(err instanceof TypeError)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await probeTranscription(config, key);
      }
    } else {
      await probeChat(config, key);
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1).replace(".", ",");
    setStatus(
      statusId,
      "success",
      `Funcionando: ${role === "transcription" ? "o servidor" : config.model} respondeu em ${seconds} s.${dirty ? " Salve para usar." : ""}`,
    );
  } catch (err) {
    setStatus(statusId, "error", describeProviderError(role, err, config.baseUrl).message);
  } finally {
    button.disabled = false;
  }
}

// ——— ValorBrain ———

async function renderVbStatus() {
  const settings = normalizeVbSettings(await readSettings());
  const chip = $("vb-status-chip");
  const detail = $("vb-status-detail");
  const connectLabel = $("vb-connect").querySelector(".vb-connect-label");
  const connected = isVbConfigured(settings);
  chip.className = `vb-chip ${connected ? "vb-chip--success" : "vb-chip--neutral"}`;
  chip.innerHTML = connected ? `${icon("checkCircle")}Conectado` : "Não conectado";
  detail.textContent = connected
    ? `API ${hostOf(settings.baseUrl)} · credencial ${maskSecret(settings.apiToken)}${settings.tenantId ? ` · tenant ${settings.tenantId}` : ""}`
    : "";
  if (connectLabel) connectLabel.textContent = connected ? "Reconectar" : "Conectar com ValorBrain";
  $("vb-disconnect").hidden = !connected;
  $("vb-test").hidden = !connected;
}

function readVbFields() {
  return {
    "vb.baseUrl": input("vb-base-url").value.trim().replace(/\/+$/, ""),
    "vb.apiToken": input("vb-api-token").value.trim(),
    "vb.tenantId": input("vb-tenant-id").value.trim(),
    "vb.autoSend": input("vb-auto-send").checked,
  };
}

async function connectVb() {
  const button = $<HTMLButtonElement>("vb-connect");
  const base = input("vb-base-url").value.trim().replace(/\/+$/, "") || VB_API_BASE_URL;
  button.disabled = true;
  setStatus("vb-action-status", "pending", "Abrindo a autorização do ValorBrain…");
  try {
    const { accessToken } = await connectValorBrain(base);
    await patchSettings({ "vb.baseUrl": base, "vb.apiToken": accessToken });
    input("vb-base-url").value = base;
    input("vb-api-token").value = accessToken;
    await renderVbStatus();
    const test = await testValorBrainConnection(normalizeVbSettings(await readSettings()));
    setStatus(
      "vb-action-status",
      test.ok ? "success" : "warning",
      test.ok
        ? "Conectado. As próximas reuniões vão para a memória da sua empresa."
        : `Conectado, mas o teste falhou: ${test.message}`,
    );
    void refreshChecklist();
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    setStatus(
      "vb-action-status",
      "error",
      /cancel|closed|did not approve|user/i.test(message)
        ? "A autorização foi fechada antes de concluir. Tente de novo."
        : `Não foi possível conectar: ${message}`,
    );
  } finally {
    button.disabled = false;
  }
}

async function testVb() {
  const button = $<HTMLButtonElement>("vb-test");
  button.disabled = true;
  setStatus("vb-action-status", "pending", "Testando a conexão…");
  try {
    const fields = readVbFields();
    const result = await testValorBrainConnection(normalizeVbSettings(fields));
    setStatus("vb-action-status", result.ok ? "success" : "error", result.message);
  } finally {
    button.disabled = false;
  }
}

async function disconnectVb() {
  await patchSettings({}, ["vb.apiToken", "vb.tenantId"]);
  input("vb-api-token").value = "";
  input("vb-tenant-id").value = "";
  await renderVbStatus();
  setStatus(
    "vb-action-status",
    "success",
    "Desconectado. As reuniões continuam salvas neste navegador.",
  );
  void refreshChecklist();
}

// ——— Microphone ———

async function renderMic() {
  const permission = await getMicPermission();
  const chip = $("mic-status-chip");
  const button = $<HTMLButtonElement>("mic-grant");
  const map = {
    granted: ["vb-chip--success", "Liberado", "checkCircle"],
    prompt: ["vb-chip--warning", "Não liberado", "alertTriangle"],
    denied: ["vb-chip--error", "Bloqueado", "alertCircle"],
    unknown: ["vb-chip--neutral", "Desconhecido", "helpCircle"],
  } as const;
  const [cls, label, iconName] = map[permission];
  chip.className = `vb-chip ${cls}`;
  chip.innerHTML = `${icon(iconName)}${label}`;
  // Once Chrome allows it, the same button checks the device for real: on
  // macOS the system can still block Chrome even with the Chrome grant.
  button.innerHTML = `${icon("mic")}${permission === "granted" ? "Testar microfone" : "Permitir microfone"}`;
  if (permission === "granted") {
    setStatus("mic-help", "success", "Sua voz entra na gravação junto com o áudio da reunião.");
  } else if (permission === "denied") {
    setStatus(
      "mic-help",
      "error",
      "O Chrome bloqueou o microfone para o ValorBrain Meet. Clique no ícone à esquerda do endereço desta página, permita o microfone e recarregue.",
    );
  } else {
    setStatus("mic-help", "", "");
  }
}

async function grantMic() {
  const permissionBefore = getMicPermission();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
    toast(
      (await permissionBefore) === "granted" ? "Microfone funcionando." : "Microfone liberado.",
    );
  } catch (err) {
    const code = microphoneErrorCode(err);
    if (code === SYSTEM_DENIED) {
      // Chrome allows it, the operating system does not: renderMic() would
      // overwrite this with the (Chrome-level) "granted" state.
      setStatus("mic-help", "error", systemMicrophoneHelp(await platformOs()));
      void refreshChecklist();
      return;
    }
    if (code === "NotFoundError") {
      setStatus("mic-help", "error", "Nenhum microfone encontrado neste computador.");
      return;
    }
    if (code === "NotReadableError" || code === "AbortError") {
      setStatus(
        "mic-help",
        "error",
        "O microfone está ocupado ou falhou ao abrir. Feche outros apps que o usam e tente de novo.",
      );
      return;
    }
  }
  await renderMic();
  void refreshChecklist();
}

// ——— Checklist ———

function checklistIcon(item: SetupItem): IconName {
  return item.state === "ok"
    ? "checkCircle"
    : item.state === "warning"
      ? "alertTriangle"
      : "alertCircle";
}

async function refreshChecklist() {
  const items = await getSetupStatus({ probe: true }).catch(() => [] as SetupItem[]);
  $("op-setup-list").innerHTML = items
    .map(
      (item) => `<li class="op-check op-check--${item.state}">
        ${icon(checklistIcon(item))}
        <div class="op-check-body">
          <div class="op-check-title">${escapeHtml(item.title)}</div>
          <div class="op-check-detail">${escapeHtml(item.detail)}</div>
        </div>
        ${item.state === "ok" ? "" : `<a class="vb-btn vb-btn--sm" href="#${escapeHtml(item.anchor)}">Resolver</a>`}
      </li>`,
    )
    .join("");
  const summary = $("op-setup-summary");
  const complete = isSetupComplete(items);
  const pending = items.filter((item) => item.state !== "ok").length;
  summary.className = `vb-chip ${complete ? "vb-chip--success" : "vb-chip--warning"}`;
  summary.innerHTML = complete
    ? `${icon("checkCircle")}Tudo pronto`
    : `${icon("alertTriangle")}${pending} ${pending === 1 ? "item pendente" : "itens pendentes"}`;
}

// ——— Load / save ———

async function loadForm() {
  const settings = await readSettings();

  for (const role of ["transcription", "summary"] as const) {
    writeProviderFields(role, await getProviderConfig(role));
    setStatus(fieldId(role, "test-status"), "", "");
  }

  // A saved value the list no longer offers falls back to detection.
  const languageSelect = $<HTMLSelectElement>("transcription-language");
  const saved =
    typeof settings.transcriptionLanguage === "string" ? settings.transcriptionLanguage : "";
  languageSelect.value = [...languageSelect.options].some((o) => o.value === saved)
    ? saved
    : DEFAULT_TRANSCRIPTION_LANGUAGE;
  $<HTMLTextAreaElement>("transcription-vocabulary").value =
    typeof settings.transcriptionVocabulary === "string" ? settings.transcriptionVocabulary : "";
  input("self-name").value = typeof settings.selfName === "string" ? settings.selfName : "";
  const noticeText = $<HTMLTextAreaElement>("recording-notice-text");
  noticeText.placeholder = DEFAULT_RECORDING_NOTICE;
  noticeText.value =
    typeof settings.recordingChatNoticeText === "string" ? settings.recordingChatNoticeText : "";

  const interval = Number(settings.summarizationInterval);
  const intervalValue =
    Number.isFinite(interval) && interval >= 120 ? Math.min(900, interval) : 180;
  input("summary-interval").value = String(intervalValue);
  renderIntervalLabel();

  const vad = Number(settings.vadThreshold);
  input("vad-threshold").value = String(Number.isFinite(vad) && vad > 0 ? vad : 0.012);
  renderVadLabel();

  for (const toggle of TOGGLES) {
    const value = settings[toggle.key];
    input(toggle.id).checked = toggle.defaultOn ? value !== false : value === true;
  }

  const theme = settings.theme === "light" || settings.theme === "dark" ? settings.theme : "system";
  $<HTMLSelectElement>("theme-select").value = theme;

  const vb = normalizeVbSettings(settings);
  input("vb-base-url").value = vb.baseUrl;
  input("vb-api-token").value = vb.apiToken;
  input("vb-tenant-id").value = vb.tenantId;
  input("vb-auto-send").checked = settings["vb.autoSend"] !== false;

  markDirty(false);
}

function renderIntervalLabel() {
  const seconds = Number(input("summary-interval").value) || 180;
  $("summary-interval-value").textContent = `${Math.round(seconds / 60)} min`;
}

function renderVadLabel() {
  $("vad-value").textContent = Number(input("vad-threshold").value).toFixed(3).replace(".", ",");
}

function originsNeedingPermission(urls: string[]): string[] {
  const origins = new Set<string>();
  for (const url of urls) {
    try {
      const origin = new URL(url).origin;
      if (!MANIFEST_HOSTS.some((pattern) => pattern.test(origin))) origins.add(`${origin}/*`);
    } catch {
      /* invalid URLs are reported by validation */
    }
  }
  return [...origins];
}

async function save() {
  const saveButton = $<HTMLButtonElement>("op-save");
  const transcription = readProviderFields("transcription");
  const summary = readProviderFields("summary");
  const vbFields = readVbFields();

  for (const [label, url] of [
    ["Transcrição", transcription.baseUrl],
    ["Resumo", summary.baseUrl],
    ...(vbFields["vb.baseUrl"] ? [["ValorBrain", vbFields["vb.baseUrl"]]] : []),
  ] as Array<[string, string]>) {
    if (!validateApiUrl(url).valid) {
      toast(
        `${label}: endereço inválido. Use https:// (http:// só para localhost ou rede local).`,
        "error",
      );
      return;
    }
  }

  // Must be requested synchronously inside the click (user gesture), before any await.
  const origins = originsNeedingPermission([
    transcription.baseUrl,
    summary.baseUrl,
    ...(vbFields["vb.baseUrl"] ? [vbFields["vb.baseUrl"]] : []),
  ]);
  const permissionRequest = origins.length
    ? chrome.permissions.request({ origins }).catch(() => false)
    : Promise.resolve(true);

  saveButton.disabled = true;
  saveButton.setAttribute("aria-busy", "true");
  try {
    const granted = await permissionRequest;
    await saveProviderConfig("transcription", transcription);
    await saveProviderConfig("summary", summary);

    const patch: Settings = {
      transcriptionLanguage: $<HTMLSelectElement>("transcription-language").value,
      transcriptionVocabulary: $<HTMLTextAreaElement>("transcription-vocabulary")
        .value.trim()
        .slice(0, 600),
      selfName: input("self-name").value.replace(/\s+/g, " ").trim().slice(0, 80),
      recordingChatNoticeText: $<HTMLTextAreaElement>("recording-notice-text")
        .value.replace(/\s+/g, " ")
        .trim()
        .slice(0, RECORDING_NOTICE_MAX_CHARS),
      summarizationInterval: Number(input("summary-interval").value) || 180,
      vadThreshold: Number(input("vad-threshold").value) || 0.012,
      theme: $<HTMLSelectElement>("theme-select").value,
      "vb.autoSend": vbFields["vb.autoSend"],
      onboardingCompleted: true,
    };
    for (const toggle of TOGGLES) patch[toggle.key] = input(toggle.id).checked;
    const removeKeys: string[] = [];
    for (const key of ["vb.baseUrl", "vb.apiToken", "vb.tenantId"] as const) {
      if (vbFields[key]) patch[key] = vbFields[key];
      else removeKeys.push(key);
    }
    await patchSettings(patch, removeKeys);
    await chrome.storage.local.set({ onboardingCompleted: true });

    markDirty(false);
    toast(
      granted
        ? "Configurações salvas."
        : "Configurações salvas, mas o acesso a um dos endereços personalizados foi negado. Ele pode falhar.",
      granted ? "info" : "error",
    );
    await renderVbStatus();
    void refreshChecklist();
  } catch (err) {
    toast(`Não foi possível salvar: ${(err as Error)?.message || err}`, "error");
  } finally {
    saveButton.disabled = false;
    saveButton.removeAttribute("aria-busy");
  }
}

// ——— Navigation ———

function flashSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  section.classList.add("is-flash");
  setTimeout(() => section.classList.remove("is-flash"), 1600);
}

function watchCurrentSection() {
  const links = new Map<string, HTMLAnchorElement>();
  document.querySelectorAll<HTMLAnchorElement>(".op-nav a").forEach((link) => {
    links.set(link.getAttribute("href")!.slice(1), link);
  });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        links.forEach((link) => link.classList.remove("is-current"));
        links.get(entry.target.id)?.classList.add("is-current");
      }
    },
    { rootMargin: "-20% 0px -70% 0px" },
  );
  links.forEach((_link, id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}

// ——— Legacy vault ———

async function setupLegacyVault() {
  const stored = await chrome.storage.local.get(["openai_api_key", "credential_encryption_salt"]);
  const hasVault = Boolean(stored.openai_api_key) || (await isVaultInitialized());
  $("op-legacy").hidden = !hasVault;
  if (!hasVault) return;

  $("legacy-unlock").addEventListener("click", async () => {
    const pass = input("legacy-passphrase").value;
    if (!pass) {
      setStatus("legacy-status", "error", "Digite a frase secreta do cofre.");
      return;
    }
    const ok = await unlockCredentials(pass);
    setStatus(
      "legacy-status",
      ok ? "success" : "error",
      ok
        ? "Cofre desbloqueado nesta sessão do navegador."
        : "Frase incorreta ou curta demais (mínimo de 8 caracteres).",
    );
  });
  $("legacy-remove").addEventListener("click", async () => {
    if (!confirm("Remover a chave antiga da OpenAI deste navegador?")) return;
    await chrome.storage.local.remove(["openai_api_key", "credential_encryption_salt"]);
    await chrome.storage.session.remove(["openai_api_key"]).catch(() => {});
    $("op-legacy").hidden = true;
    toast("Chave antiga removida.");
  });
}

// ——— Boot ———

document.addEventListener("DOMContentLoaded", async () => {
  hydrateIcons();
  $("op-version").textContent = chrome.runtime.getManifest().version;

  populateProfileSelect("transcription");
  populateProfileSelect("summary");
  await loadForm();
  await renderVbStatus();
  void renderMic();
  void refreshChecklist();
  void setupLegacyVault();
  watchCurrentSection();

  // Dirty tracking for everything that goes through "Salvar alterações".
  document.querySelectorAll<HTMLElement>("[data-dirty]").forEach((el) => {
    el.addEventListener("input", () => markDirty(true));
    el.addEventListener("change", () => markDirty(true));
  });

  for (const role of ["transcription", "summary"] as const) {
    $(fieldId(role, "profile")).addEventListener("change", () => onProfileChange(role));
    $(fieldId(role, "test")).addEventListener("click", () => void runProviderTest(role));
  }
  input("summary-interval").addEventListener("input", renderIntervalLabel);
  input("vad-threshold").addEventListener("input", renderVadLabel);
  $<HTMLSelectElement>("theme-select").addEventListener("change", (event) => {
    applyTheme({ theme: (event.target as HTMLSelectElement).value as "system" | "light" | "dark" });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-reveal]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = input(button.dataset.reveal || "");
      const reveal = target.type === "password";
      target.type = reveal ? "text" : "password";
      button.textContent = reveal ? "Ocultar" : "Mostrar";
      button.setAttribute("aria-label", reveal ? "Ocultar" : "Mostrar");
    });
  });

  $("vb-connect").addEventListener("click", () => void connectVb());
  $("vb-test").addEventListener("click", () => void testVb());
  $("vb-disconnect").addEventListener("click", () => void disconnectVb());
  $("mic-grant").addEventListener("click", () => void grantMic());

  $("op-save").addEventListener("click", () => void save());
  $("op-discard").addEventListener("click", async () => {
    await loadForm();
    applyTheme((await readSettings()) as { theme: "system" | "light" | "dark" });
    toast("Alterações descartadas.");
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });

  $("clear-data-btn").addEventListener("click", async () => {
    if (
      !confirm(
        "Apagar reuniões, chaves e configurações deste navegador? O que está no ValorBrain não é afetado.",
      )
    )
      return;
    await chrome.storage.local.clear();
    await chrome.storage.session?.clear?.();
    markDirty(false);
    location.reload();
  });

  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    status.onchange = () => {
      void renderMic();
      void refreshChecklist();
    };
  } catch {
    /* permissions API unavailable */
  }

  const storageContainer = $("storage-dashboard-container");
  if (storageContainer) void renderStorageDashboard(storageContainer);
  const usageContainer = $("api-usage-dashboard-container");
  if (usageContainer) void renderApiUsageDashboard(usageContainer);

  // First run (opened by the installer) shows the welcome card.
  const { onboardingCompleted } = await chrome.storage.local.get("onboardingCompleted");
  if (location.search.includes("onboarding=1") && !onboardingCompleted) {
    $("boas-vindas").hidden = false;
  }
  $("op-welcome-done").addEventListener("click", async () => {
    $("boas-vindas").hidden = true;
    await chrome.storage.local.set({ onboardingCompleted: true });
    flashSection("primeiros-passos");
  });

  if (location.hash) flashSection(location.hash.slice(1));
  window.addEventListener("hashchange", () => flashSection(location.hash.slice(1)));
});
