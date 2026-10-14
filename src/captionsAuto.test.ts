import test from "node:test";
import assert from "node:assert/strict";

import {
  captionControlState,
  captionsNote,
  ensureCaptionsOn,
  isCaptionsStatus,
  isSafeFocusForShortcut,
  mergeCaptionsStatus,
  pickCaptionControl,
  type CaptionsEnv,
  type CaptionsState,
} from "./captionsAuto.ts";

/** A Meet page whose captions change only when something turns them on. */
function page(
  initial: CaptionsState,
  options: { clickWorks?: boolean; shortcutWorks?: boolean; focusSafe?: boolean } = {},
) {
  const { clickWorks = true, shortcutWorks = true, focusSafe = true } = options;
  let state = initial;
  const log: string[] = [];
  const env: CaptionsEnv = {
    enabled: true,
    state: () => state,
    clickTurnOn: () => {
      if (state !== "off") return false;
      log.push("click");
      if (clickWorks) state = "on";
      return true;
    },
    pressShortcut: () => {
      if (!focusSafe) return false;
      log.push("key");
      // "c" toggles: it would turn captions off if they were on.
      if (shortcutWorks) state = state === "on" ? "off" : "on";
      return true;
    },
    wait: async (ms) => {
      log.push(`wait ${ms}`);
    },
  };
  return { env, log, now: () => state, set: (next: CaptionsState) => (state = next) };
}

const actions = (log: string[]) => log.filter((entry) => !entry.startsWith("wait"));

test("captions already on: nothing is clicked or pressed", async () => {
  const meet = page("on");
  assert.equal(await ensureCaptionsOn(meet.env), "already-on");
  assert.deepEqual(meet.log, []);
});

test("captions off: one click turns them on, and the state is read again before saying so", async () => {
  const meet = page("off");
  assert.equal(await ensureCaptionsOn(meet.env), "enabled");
  assert.deepEqual(meet.log, ["click", "wait 500"]);
  assert.equal(meet.now(), "on");
});

test("Meet updates the button late: the extension waits instead of clicking again", async () => {
  const meet = page("off", { clickWorks: false });
  let reads = 0;
  const env: CaptionsEnv = {
    ...meet.env,
    // The click took effect, but the button says "on" only on the third read.
    state: () => (++reads >= 3 ? "on" : "off"),
  };
  assert.equal(await ensureCaptionsOn(env), "enabled");
  assert.deepEqual(actions(meet.log), ["click"]);
});

test("nothing works: two clicks, then the shortcut once, then the panel hint", async () => {
  const meet = page("off", { clickWorks: false, shortcutWorks: false });
  assert.equal(await ensureCaptionsOn(meet.env), "failed");
  assert.deepEqual(actions(meet.log), ["click", "click", "key"]);
  assert.equal(captionsNote("failed"), "Ligue as legendas (CC) para identificar quem fala.");
});

test("the shortcut turns them on when the button does not", async () => {
  const meet = page("off", { clickWorks: false });
  assert.equal(await ensureCaptionsOn(meet.env), "enabled");
  assert.deepEqual(actions(meet.log), ["click", "click", "key"]);
  assert.equal(meet.now(), "on");
});

test("with the focus in a text field the shortcut is never pressed", async () => {
  const meet = page("off", { clickWorks: false, focusSafe: false });
  assert.equal(await ensureCaptionsOn(meet.env), "failed");
  assert.deepEqual(actions(meet.log), ["click", "click"]);
});

test("a state it cannot read is never acted on (no toggling captions off by mistake)", async () => {
  const meet = page("unknown");
  assert.equal(await ensureCaptionsOn(meet.env), "failed");
  assert.deepEqual(actions(meet.log), []);
});

test("the toolbar appears late: the extension acts once it reads 'off'", async () => {
  const meet = page("unknown");
  let reads = 0;
  const env: CaptionsEnv = {
    ...meet.env,
    state: () => (++reads === 2 ? (meet.set("off"), "off") : meet.now()),
  };
  assert.equal(await ensureCaptionsOn(env), "enabled");
  assert.deepEqual(actions(meet.log), ["click"]);
});

test("the setting off: no click, no key, no hint", async () => {
  const meet = page("off");
  assert.equal(await ensureCaptionsOn({ ...meet.env, enabled: false }), "disabled");
  assert.deepEqual(meet.log, []);
  assert.equal(captionsNote("disabled"), "");
});

test("the CC button's state comes from its label, aria-pressed or icon, in pt, en and es", () => {
  const cases: Array<[string, string | null, string, CaptionsState]> = [
    ["Ativar legendas (c)", null, "closed_caption_off", "off"],
    ["Desativar legendas (c)", null, "closed_caption", "on"],
    ["Turn on captions (c)", null, "", "off"],
    ["Turn off captions (c)", null, "", "on"],
    ["Activar subtítulos (c)", null, "", "off"],
    ["Desactivar subtítulos (c)", null, "", "on"],
    ["Legendas", "true", "", "on"],
    ["Captions", "false", "", "off"],
    ["", null, "closed_caption_off", "off"],
    ["", null, "closed_caption", "on"],
    // Not the toggle: caption settings, other toolbar buttons.
    ["Configurações de legendas", null, "", "unknown"],
    ["Desativar microfone (ctrl + d)", null, "mic", "unknown"],
    ["Turn off camera", "true", "videocam", "unknown"],
  ];
  for (const [label, pressed, text, expected] of cases) {
    assert.equal(captionControlState({ label, pressed, text }), expected, label || text);
  }
  assert.deepEqual(
    pickCaptionControl([
      { label: "Desativar microfone", pressed: null, text: "mic" },
      { label: "Ativar legendas (c)", pressed: null, text: "closed_caption_off" },
    ]),
    { index: 1, state: "off" },
  );
  assert.equal(pickCaptionControl([{ label: "Sair da chamada", pressed: null, text: "" }]), null);
});

test("the shortcut is pressed only when no text field has the focus", () => {
  assert.equal(isSafeFocusForShortcut(null), true);
  assert.equal(
    isSafeFocusForShortcut({ tagName: "BUTTON", isContentEditable: false, role: null }),
    true,
  );
  assert.equal(
    isSafeFocusForShortcut({ tagName: "textarea", isContentEditable: false, role: null }),
    false,
  );
  assert.equal(
    isSafeFocusForShortcut({ tagName: "INPUT", isContentEditable: false, role: null }),
    false,
  );
  assert.equal(
    isSafeFocusForShortcut({ tagName: "DIV", isContentEditable: true, role: null }),
    false,
  );
  assert.equal(
    isSafeFocusForShortcut({ tagName: "DIV", isContentEditable: false, role: "textbox" }),
    false,
  );
});

test("once the extension turned captions on, the recording says so after a reload", () => {
  assert.equal(mergeCaptionsStatus(undefined, "failed"), "failed");
  assert.equal(mergeCaptionsStatus("failed", "already-on"), "already-on");
  assert.equal(mergeCaptionsStatus("enabled", "already-on"), "enabled");
  assert.equal(mergeCaptionsStatus("enabled", "failed"), "enabled");
  assert.equal(
    captionsNote("enabled"),
    "Legendas ligadas pela extensão para identificar quem fala.",
  );
  assert.equal(isCaptionsStatus("enabled"), true);
  assert.equal(isCaptionsStatus("toString"), false);
  assert.equal(isCaptionsStatus(1), false);
});
