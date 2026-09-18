import {
  getApiCredentials,
  saveApiCredentials,
  unlockCredentials,
  isUnlocked,
  isVaultInitialized,
} from "./utils/credentials";
import { validateProviderConnection } from "./utils/api.js";
import {
  getProviderConfig,
  getProviderProfile,
  migrateProviderSettings,
  normalizeProviderConfig,
  providerConfigFromProfile,
  saveProviderConfig,
  type ProviderConfig,
  type ProviderRole,
} from "./utils/providerSettings";
import { validateApiUrl } from "./utils/urlValidator";
import { renderStorageDashboard } from "./storageDashboard";
import { renderApiUsageDashboard } from "./apiUsageDashboard";
import { MIN_PASSPHRASE_LENGTH, evaluatePassphraseStrength } from "./passphraseStrength";
import { getSettings } from "./settings";

/**
 * Strongly-typed map of all recognized extension settings keys and their
 * expected value types. Used to provide type safety alongside the open-ended
 * `Settings` type that allows arbitrary extra keys.
 */
interface KnownSettings {
  summarizationInterval?: number;
  vadThreshold?: number;
  lateJoinerBriefing?: boolean;
  publicLateJoinerChat?: boolean;
  topicDetection?: boolean;
  decisionDetection?: boolean;
  actionExtraction?: boolean;
  sentimentAnalysis?: boolean;
  transcriptRefinement?: boolean;
  theme?: "system" | "light" | "dark";
  accent?: string;
}

/**
 * The full settings object stored in chrome.storage.local. Combines all known
 * typed settings with an open index signature that preserves any unrecognized
 * keys written by older or future extension versions.
 */
type Settings = KnownSettings & Record<string, unknown>;

/**
 * A union of all `KnownSettings` keys whose value type is `boolean | undefined`.
 * Used to constrain the feature-toggle mapping so only boolean settings can be
 * bound to checkbox inputs.
 */
type BooleanSettingKey = {
  [Key in keyof KnownSettings]-?: KnownSettings[Key] extends boolean | undefined ? Key : never;
}[keyof KnownSettings];

/**
 * Applies theme and accent-color CSS variables to the document root immediately,
 * giving users instant visual feedback as they interact with the theme controls.
 * When `theme` is `"system"`, the active theme is resolved from the OS preference.
 * @param theme - The desired theme: `"system"`, `"light"`, or `"dark"`.
 * @param accent - A CSS HSL string (e.g. `"210, 100%, 50%"`) for the accent color.
 */
function applyThemePreview(theme: "system" | "light" | "dark", accent: string) {
  const root = document.documentElement;

  let activeTheme = theme;
  if (theme === "system") {
    activeTheme = globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  root.setAttribute("data-theme", activeTheme);
  root.style.setProperty("--accent-color", accent);
}

// ——— AI Providers section helpers ———
// DOM ids follow `${role}-${field}` and must stay in sync with options.html.

type ProviderField = "profile" | "base-url" | "api-key" | "model" | "test" | "test-status";

function providerInputId(role: ProviderRole, field: ProviderField): string {
  return `${role}-${field}`;
}

function providerRoleLabel(role: ProviderRole): string {
  return role === "transcription" ? "Transcription" : "Summary";
}

function inputValue(id: string): string {
  return ((document.getElementById(id) as HTMLInputElement | null)?.value ?? "").trim();
}

function setInputValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.value = value;
}

function readProviderFields(role: ProviderRole): ProviderConfig {
  const select = document.getElementById(
    providerInputId(role, "profile"),
  ) as HTMLSelectElement | null;
  return normalizeProviderConfig(role, {
    profile: select?.value,
    baseUrl: inputValue(providerInputId(role, "base-url")),
    apiKey: inputValue(providerInputId(role, "api-key")),
    model: inputValue(providerInputId(role, "model")),
  });
}

function writeProviderFields(role: ProviderRole, config: ProviderConfig): void {
  const select = document.getElementById(
    providerInputId(role, "profile"),
  ) as HTMLSelectElement | null;
  if (select) select.value = config.profile;
  setInputValue(providerInputId(role, "base-url"), config.baseUrl);
  setInputValue(providerInputId(role, "api-key"), config.apiKey);
  setInputValue(providerInputId(role, "model"), config.model);
}

function applyProviderProfilePreset(role: ProviderRole, profileId: string): void {
  const preset = getProviderProfile(profileId);
  if (!preset) return; // "custom" keeps the current fields untouched
  setInputValue(providerInputId(role, "base-url"), preset.baseUrl);
  setInputValue(providerInputId(role, "model"), preset.model);
}

async function testProviderConnection(role: ProviderRole): Promise<void> {
  const statusEl = document.getElementById(providerInputId(role, "test-status"));
  if (statusEl) {
    statusEl.className = "passphrase-status";
    statusEl.textContent = "Testing connection…";
  }

  const ok = await validateProviderConnection(readProviderFields(role));
  if (statusEl) {
    statusEl.className = `passphrase-status status-${ok ? "success" : "danger"}`;
    statusEl.textContent = ok
      ? `${providerRoleLabel(role)} provider reachable — connection OK.`
      : `${providerRoleLabel(role)} provider unreachable. Check the base URL and API key.`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // ——— Load saved settings ———
  // Uses the shared getSettings() helper instead of re-fetching/parsing the
  // config object inline (#666).
  const [credentials, loadedSettings] = await Promise.all([getApiCredentials(), getSettings()]);

  const settings: Settings = loadedSettings;

  // ——— Populate Existing UI Elements ———
  const versionDisplay = document.getElementById("version-display");
  if (versionDisplay) {
    versionDisplay.textContent = chrome.runtime.getManifest().version;
  }

  // VAD threshold slider
  const vadSlider = document.getElementById("vad-threshold") as HTMLInputElement | null;
  const vadValue = document.getElementById("vad-value");
  if (vadSlider && vadValue) {
    vadSlider.value = String(settings.vadThreshold || 0.012);
    vadValue.textContent = vadSlider.value;
    vadSlider.addEventListener("input", () => {
      vadValue.textContent = vadSlider.value;
    });
  }

  const openaiKeyInput = document.getElementById("openai-key") as HTMLInputElement | null;
  if (openaiKeyInput && credentials.openai_api_key) {
    openaiKeyInput.value = credentials.openai_api_key;
  }

  // ——— AI Providers ———
  // Runs the one-time legacy migration before reading, so a pre-existing
  // OpenAI credential shows up as the OpenAI profile instead of the defaults.
  await migrateProviderSettings().catch((err) =>
    console.warn("[LateMeet] Provider settings migration failed:", err),
  );

  for (const role of ["transcription", "summary"] as const) {
    const config = await getProviderConfig(role);
    writeProviderFields(role, config);

    const select = document.getElementById(
      providerInputId(role, "profile"),
    ) as HTMLSelectElement | null;
    select?.addEventListener("change", () => applyProviderProfilePreset(role, select.value));

    document
      .getElementById(providerInputId(role, "test"))
      ?.addEventListener("click", () => void testProviderConnection(role));
  }

  // Interval slider
  const intervalSlider = document.getElementById("summary-interval") as HTMLInputElement | null;
  const intervalValue = document.getElementById("interval-value");
  if (intervalSlider && intervalValue) {
    intervalSlider.value = String(settings.summarizationInterval || 300);
    intervalValue.textContent = `${Number(intervalSlider.value) / 60} min`;

    intervalSlider.addEventListener("input", () => {
      intervalValue.textContent = `${Number(intervalSlider.value) / 60} min`;
    });
  }

  // Onboarding support: render if requested via query or via button
  const onboardingRoot = document.getElementById("onboarding-root") as HTMLDivElement | null;
  const viewOnboardingBtn = document.getElementById("view-onboarding") as HTMLButtonElement | null;

  if (globalThis.location.search.includes("onboarding=1") && onboardingRoot) {
    const setupView = document.getElementById("setup-view") as HTMLDivElement | null;
    const mainView = document.getElementById("main-view") as HTMLDivElement | null;
    if (setupView) setupView.style.display = "none";
    if (mainView) mainView.style.display = "none";
    const mod = await import("./onboarding");
    await mod.renderOnboarding(onboardingRoot);
    return;
  }

  viewOnboardingBtn?.addEventListener("click", async () => {
    if (!onboardingRoot) return;
    const setupView = document.getElementById("setup-view") as HTMLDivElement | null;
    const mainView = document.getElementById("main-view") as HTMLDivElement | null;
    if (setupView) setupView.style.display = "none";
    if (mainView) mainView.style.display = "none";
    const mod = await import("./onboarding");
    await mod.renderOnboarding(onboardingRoot);
  });

  // ——— Clear Data ———
  document.getElementById("clear-data-btn")?.addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear all data? This cannot be undone.")) {
      await chrome.storage.local.clear();
      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        await chrome.storage.session.clear();
      }
      alert("All data cleared successfully. The page will now reload.");
      globalThis.location.reload();
    }
  });

  // AI model selection moved to the AI Providers section (per-provider model).

  // Feature toggles
  const toggles: Array<{ id: string; key: BooleanSettingKey }> = [
    { id: "late-joiner-toggle", key: "lateJoinerBriefing" },
    { id: "public-late-joiner-chat-toggle", key: "publicLateJoinerChat" },
    { id: "topic-toggle", key: "topicDetection" },
    { id: "decision-toggle", key: "decisionDetection" },
    { id: "action-toggle", key: "actionExtraction" },
    { id: "sentiment-toggle", key: "sentimentAnalysis" },
    { id: "refinement-toggle", key: "transcriptRefinement" },
  ];

  // Keys that default to off (opt-in features)
  const defaultOffKeys = new Set(["publicLateJoinerChat", "transcriptRefinement"]);

  toggles.forEach((t) => {
    const el = document.getElementById(t.id) as HTMLInputElement | null;
    if (el) {
      el.checked = defaultOffKeys.has(t.key) ? settings[t.key] === true : settings[t.key] !== false;
    }
  });

  let selectedAccentColor = settings.accent || "210, 100%, 50%";

  // ——— NEW: Theme & Color Initializations ———
  const themeSelect = document.getElementById("theme-select") as HTMLSelectElement | null;
  const currentTheme = settings.theme || "system";
  const currentAccent = selectedAccentColor;

  if (themeSelect) {
    themeSelect.value = currentTheme;
  }

  // Run initial theme application right away so options page isn't broken
  applyThemePreview(currentTheme, currentAccent);

  // Enable transitions after initial application completes to prevent page-load transitions
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("no-transitions");
    });
  });

  // Set the active styling on the matching color dot button
  document.querySelectorAll(".color-dot").forEach((dot) => {
    const dotColor = dot.getAttribute("data-color");
    const isActive = dotColor === currentAccent;
    if (isActive) {
      dot.classList.add("active");
    }
    dot.setAttribute("aria-pressed", String(isActive));

    // Listen for color grid selections to give instant feedback
    dot.addEventListener("click", () => {
      document.querySelectorAll(".color-dot").forEach((d) => {
        d.classList.remove("active");
        d.setAttribute("aria-pressed", "false");
      });
      dot.classList.add("active");
      dot.setAttribute("aria-pressed", "true");

      const selectedTheme = (themeSelect?.value as Settings["theme"]) || "system";
      selectedAccentColor = dot.getAttribute("data-color") || "210, 100%, 50%";
      applyThemePreview(selectedTheme, selectedAccentColor);
    });
  });

  // Listen for dropdown theme changes to give instant feedback
  themeSelect?.addEventListener("change", () => {
    let selectedTheme = themeSelect.value as Settings["theme"];
    if (!selectedTheme) {
      selectedTheme = "system";
    }
    applyThemePreview(selectedTheme, selectedAccentColor);
  });

  // ——— Toggle password visibility ———
  document.querySelectorAll<HTMLElement>(".toggle-vis").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      if (targetId) {
        const target = document.getElementById(targetId) as HTMLInputElement | null;
        if (target) {
          target.type = target.type === "password" ? "text" : "password";
        }
      }
    });
  });

  // ——— Passphrase management ———
  const passphraseInput = document.getElementById("passphrase-input") as HTMLInputElement | null;
  const passphraseStatus = document.getElementById("passphrase-status");
  const strengthEl = document.getElementById("vault-strength");
  let pendingUnlock: Promise<void> | null = null;
  // Strength rules apply only when first setting up a vault; unlocking an
  // existing vault must never be blocked, even if its passphrase is weak (#655).
  let vaultInitialized = await isVaultInitialized();

  // Centralizes status writes through a non-secret-named target so the static
  // analyzer doesn't misread them as hard-coded credentials.
  function setStatusMessage(el: HTMLElement | null, kind: "danger" | "success", text: string) {
    if (!el) return;
    el.className = `passphrase-status status-${kind}`;
    el.textContent = text;
  }

  function updateStrengthIndicator() {
    if (!strengthEl) return;
    const typed = passphraseInput?.value ?? "";

    // Only show strength feedback during first-time setup of the vault.
    if (vaultInitialized || isUnlocked() || typed.length === 0) {
      strengthEl.textContent = "";
      strengthEl.className = "vault-strength";
      return;
    }

    const { score, label, meetsMinimum, suggestions } = evaluatePassphraseStrength(typed);
    const detail = meetsMinimum && suggestions.length ? ` — ${suggestions.join(", ")}` : "";
    strengthEl.textContent = `Strength: ${label}${detail}`;
    strengthEl.className = `vault-strength strength-${score}`;
  }

  function updatePassphraseUI() {
    if (passphraseInput) passphraseInput.disabled = isUnlocked();
    if (isUnlocked()) {
      setStatusMessage(
        passphraseStatus,
        "success",
        "Unlocked — encryption key is active in memory",
      );
    } else {
      setStatusMessage(
        passphraseStatus,
        "danger",
        "Locked — enter passphrase to unlock credential encryption",
      );
    }
  }

  async function applyUnlockedCredentials() {
    const creds = await getApiCredentials();
    if (openaiKeyInput && creds.openai_api_key) {
      openaiKeyInput.value = creds.openai_api_key;
    }
  }

  async function handleUnlock() {
    if (isUnlocked()) return;
    const typed = passphraseInput?.value ?? "";
    if (!typed) {
      setStatusMessage(passphraseStatus, "danger", "Please enter a passphrase");
      return;
    }

    // First-time setup: enforce minimum strength before creating the vault.
    if (!vaultInitialized && !evaluatePassphraseStrength(typed).meetsMinimum) {
      setStatusMessage(
        passphraseStatus,
        "danger",
        `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
      );
      return;
    }

    if (!(await unlockCredentials(typed))) {
      setStatusMessage(
        passphraseStatus,
        "danger",
        "Wrong passphrase — could not decrypt stored credentials",
      );
      return;
    }

    vaultInitialized = true;
    updateStrengthIndicator();
    updatePassphraseUI();
    await applyUnlockedCredentials();
  }

  passphraseInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      pendingUnlock = handleUnlock();
    }
  });
  passphraseInput?.addEventListener("blur", () => {
    pendingUnlock = handleUnlock();
  });
  passphraseInput?.addEventListener("input", updateStrengthIndicator);

  updatePassphraseUI();
  updateStrengthIndicator();

  // ——— Save ———
  document.getElementById("save-btn")?.addEventListener("click", async () => {
    const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
    const status = document.getElementById("save-status");

    const openaiKey =
      (document.getElementById("openai-key") as HTMLInputElement | null)?.value.trim() ?? "";

    const originalText = saveBtn.textContent?.trim() || "Save Settings";
    saveBtn.disabled = true;
    try {
      // ——— AI Providers blocks ———
      for (const role of ["transcription", "summary"] as const) {
        const config = readProviderFields(role);
        const urlCheck = validateApiUrl(config.baseUrl);
        if (!urlCheck.valid) {
          if (status) {
            status.style.color = "red";
            status.textContent = `${providerRoleLabel(role)} base URL: ${urlCheck.error}`;
            status.classList.add("visible");
            setTimeout(() => status.classList.remove("visible"), 4000);
          }
          saveBtn.disabled = false;
          saveBtn.textContent = originalText;
          return;
        }
        await saveProviderConfig(role, config);
      }

      const parsedInterval = intervalSlider ? parseInt(intervalSlider.value, 10) : 300;
      let validatedInterval =
        Number.isNaN(parsedInterval) || !Number.isFinite(parsedInterval) ? 300 : parsedInterval;
      if (validatedInterval < 300) validatedInterval = 300;
      if (validatedInterval > 900) validatedInterval = 900;

      const parsedVadThreshold = vadSlider ? parseFloat(vadSlider.value) : 0.012;
      let validatedVadThreshold =
        Number.isNaN(parsedVadThreshold) || !Number.isFinite(parsedVadThreshold)
          ? 0.012
          : parsedVadThreshold;
      if (validatedVadThreshold < 0.001) validatedVadThreshold = 0.001;
      if (validatedVadThreshold > 1.0) validatedVadThreshold = 1.0;

      const newSettings: Settings = {
        ...settings, // Retain existing unmapped fields
        summarizationInterval: validatedInterval,
        vadThreshold: validatedVadThreshold,
        lateJoinerBriefing: (document.getElementById("late-joiner-toggle") as HTMLInputElement)
          ?.checked,
        publicLateJoinerChat: (
          document.getElementById("public-late-joiner-chat-toggle") as HTMLInputElement
        )?.checked,
        topicDetection: (document.getElementById("topic-toggle") as HTMLInputElement)?.checked,
        decisionDetection: (document.getElementById("decision-toggle") as HTMLInputElement)
          ?.checked,
        actionExtraction: (document.getElementById("action-toggle") as HTMLInputElement)?.checked,
        sentimentAnalysis: (document.getElementById("sentiment-toggle") as HTMLInputElement)
          ?.checked,
        transcriptRefinement: (document.getElementById("refinement-toggle") as HTMLInputElement)
          ?.checked,

        // Save theme selections into the global config tree bundle block
        theme: (themeSelect?.value as Settings["theme"]) || "system",
        accent: selectedAccentColor,
      };

      await chrome.storage.local.set({ settings: newSettings });

      let credentialsSaved = false;
      if (pendingUnlock) await pendingUnlock;
      if (isUnlocked()) {
        saveBtn.textContent = "Validating Keys...";
        const isOpenAIValid = openaiKey
          ? await validateProviderConnection(providerConfigFromProfile("openai", openaiKey))
          : true;

        if (!isOpenAIValid) {
          if (status) {
            status.style.color = "red";
            status.textContent = "Invalid OpenAI API key. Please check and try again.";
            status.classList.add("visible");
            setTimeout(() => status.classList.remove("visible"), 4000);
          }
          saveBtn.disabled = false;
          saveBtn.textContent = originalText;
          return;
        }

        const credentialsToSave: { openai_api_key?: string } = {};
        if (openaiKey) credentialsToSave.openai_api_key = openaiKey;
        if (Object.keys(credentialsToSave).length > 0) {
          await saveApiCredentials(credentialsToSave);
        }
        credentialsSaved = true;
      }

      // Show success
      if (status) {
        status.style.color = credentialsSaved ? "" : "var(--accent-color, #22C55E)";
        status.textContent = credentialsSaved
          ? "Settings saved successfully!"
          : "Settings saved. Unlock credential encryption to update API keys.";
        status.classList.add("visible");

        setTimeout(() => {
          status.classList.remove("visible");
        }, 3000);
      }
    } catch (error) {
      console.error("Error saving settings:", error);
      if (status) {
        status.style.color = "red";
        status.textContent = "An error occurred while saving. Please try again.";
        status.classList.add("visible");
        setTimeout(() => status.classList.remove("visible"), 4000);
      }
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  });
  // ——— Storage Dashboard ———
  const storageContainer = document.getElementById("storage-dashboard-container");
  if (storageContainer) {
    await renderStorageDashboard(storageContainer);
  }

  // ——— API Usage Dashboard ———
  const usageContainer = document.getElementById("api-usage-dashboard-container");
  if (usageContainer) {
    await renderApiUsageDashboard(usageContainer);
  }
});
