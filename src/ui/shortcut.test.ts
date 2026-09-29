import test from "node:test";
import assert from "node:assert/strict";

import { shortcutKeys } from "./shortcut.ts";

test("Windows/Linux bindings split on +", () => {
  assert.deepEqual(shortcutKeys("Alt+Shift+G"), ["Alt", "Shift", "G"]);
  assert.deepEqual(shortcutKeys(" Ctrl + Shift + F5 "), ["Ctrl", "Shift", "F5"]);
});

test("macOS bindings split into modifier symbols and the key", () => {
  assert.deepEqual(shortcutKeys("⌥⇧G"), ["⌥", "⇧", "G"]);
  assert.deepEqual(shortcutKeys("⌘⇧F5"), ["⌘", "⇧", "F5"]);
  assert.deepEqual(shortcutKeys("⌃⌥Space"), ["⌃", "⌥", "Space"]);
});

test("unbound or single-key shortcuts", () => {
  assert.deepEqual(shortcutKeys(""), []);
  assert.deepEqual(shortcutKeys(undefined), []);
  assert.deepEqual(shortcutKeys("F9"), ["F9"]);
});
