/**
 * @fileoverview Splits a `chrome.commands` shortcut into its keys for display.
 * Chrome formats bindings as "Alt+Shift+G" on Windows/Linux and as modifier
 * symbols without separators on macOS ("⌥⇧G"). Dependency-free: the Meet
 * content script imports it too.
 */

const MAC_MODIFIER = /[⌘⌥⇧⌃]/;

/** "Alt+Shift+G" → ["Alt", "Shift", "G"]; "⌥⇧G" → ["⌥", "⇧", "G"]; "" → []. */
export function shortcutKeys(shortcut: string | null | undefined): string[] {
  const value = String(shortcut ?? "").trim();
  if (!value) return [];
  if (value.includes("+")) {
    return value
      .split("+")
      .map((key) => key.trim())
      .filter(Boolean);
  }
  if (!MAC_MODIFIER.test(value)) return [value];
  return value.match(/[⌘⌥⇧⌃]|[^⌘⌥⇧⌃]+/g) ?? [value];
}
