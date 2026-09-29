// Theme application for extension pages (popup, side panel, options).
// Light mode uses the brand "Paper" surface; dark mode uses Obsidian.
import { getSettings, normalizeSettings, type Settings, type ThemeMode } from "./settings";

// Re-exported for backward compatibility with existing importers (#666).
export { getSettings, isValidAccent } from "./settings";
export type { Settings } from "./settings";

/** Resolves the user's mode to the concrete brand theme attribute. */
export function resolveTheme(theme: ThemeMode): "paper" | "dark" {
  if (theme === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "paper";
    }
    return "paper";
  }
  return theme === "dark" ? "dark" : "paper";
}

export function applyTheme(settings: Pick<Settings, "theme">): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(settings.theme);
}

export async function syncTheme(): Promise<void> {
  applyTheme(await getSettings());
}

function handleStorageChange(
  changes: { [key: string]: chrome.storage.StorageChange },
  namespace: string,
): void {
  if (namespace !== "local" || !("settings" in changes)) return;
  applyTheme(normalizeSettings(changes.settings?.newValue));
}

async function handleSystemThemeChange(): Promise<void> {
  const settings = await getSettings();
  if (settings.theme === "system") applyTheme(settings);
}

export function watchTheme(): void {
  chrome.storage.onChanged.addListener(handleStorageChange);
  if (typeof window !== "undefined" && window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", handleSystemThemeChange);
  }
}

export async function initTheme(): Promise<void> {
  await syncTheme();
  watchTheme();
}
