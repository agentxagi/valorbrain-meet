import test from "node:test";
import assert from "node:assert/strict";

import {
  captionControlState,
  captionsNote,
  ensureCaptionsOn,
  isCaptionsStatus,
  mergeCaptionsStatus,
  pickCaptionControl,
  type CaptionsEnv,
  type CaptionsState,
} from "./captionsAuto.ts";

/**
 * A Meet page on a clock. The CC button is a real toggle: a second click turns
 * captions back off. The button's label and the caption region may show the
 * change late (or never), and the toolbar may appear late (the lobby).
 */
function page(
  initiallyOn: boolean,
  options: {
    clickWorks?: boolean;
    /** ms after a change before the label reads it. */
    labelDelayMs?: number;
    /** ms after captions go on before the region shows them. */
    regionDelayMs?: number;
    /** When the toolbar can be read at all. */
    toolbarAtMs?: number;
    /** When the recording ends. */
    recordingEndsAtMs?: number;
  } = {},
) {
  const {
    clickWorks = true,
    labelDelayMs = 0,
    regionDelayMs = Infinity,
    toolbarAtMs = 0,
    recordingEndsAtMs = Infinity,
  } = options;
  let clock = 0;
  let on = initiallyOn;
  let labelOn = initiallyOn;
  let changedAt = -Infinity;
  const log: string[] = [];
  const label = (): CaptionsState => {
    if (clock < toolbarAtMs) return "unknown";
    if (clock - changedAt >= labelDelayMs) labelOn = on;
    return labelOn ? "on" : "off";
  };
  const env: CaptionsEnv = {
    enabled: true,
    active: () => clock < recordingEndsAtMs,
    state: label,
    captionsShowing: () => on && clock - changedAt >= regionDelayMs,
    clickTurnOn: () => {
      if (label() !== "off") return false;
      log.push(`click@${clock}`);
      if (clickWorks) {
        on = !on;
        changedAt = clock;
      }
      return true;
    },
    wait: async (ms) => {
      clock += ms;
    },
  };
  return { env, log, isOn: () => on, clock: () => clock };
}

test("captions already on: nothing is clicked", async () => {
  const meet = page(true);
  assert.equal(await ensureCaptionsOn(meet.env), "already-on");
  assert.deepEqual(meet.log, []);
});

test("captions off: one click turns them on", async () => {
  const meet = page(false);
  assert.equal(await ensureCaptionsOn(meet.env), "enabled");
  assert.deepEqual(meet.log, ["click@0"]);
  assert.equal(meet.isOn(), true);
});

test("the label says 'on' 3 s after a click that worked: exactly one click, captions stay on", async () => {
  const meet = page(false, { labelDelayMs: 3000 });
  assert.equal(await ensureCaptionsOn(meet.env), "enabled");
  assert.deepEqual(meet.log, ["click@0"]);
  assert.equal(meet.isOn(), true);
});

test("the caption region shows before the label changes: enabled, nothing more is done", async () => {
  const meet = page(false, { labelDelayMs: Infinity, regionDelayMs: 1000 });
  assert.equal(await ensureCaptionsOn(meet.env), "enabled");
  assert.deepEqual(meet.log, ["click@0"]);
  assert.equal(meet.isOn(), true);
});

test("a hidden tab redraws nothing in 6 s: one click, the hint, and the captions stay on", async () => {
  const meet = page(false, { labelDelayMs: Infinity });
  assert.equal(await ensureCaptionsOn(meet.env), "failed");
  assert.deepEqual(meet.log, ["click@0"]);
  assert.equal(meet.isOn(), true, "nothing undid the click");
});

test("the click does nothing: one click, then 'failed' and the panel hint, never a key", async () => {
  const meet = page(false, { clickWorks: false });
  assert.equal(await ensureCaptionsOn(meet.env), "failed");
  assert.deepEqual(meet.log, ["click@0"]);
  assert.equal(captionsNote("failed"), "Ligue as legendas (CC) para identificar quem fala.");
});

test("recording from the lobby: it waits for the call's toolbar, then clicks once", async () => {
  const meet = page(false, { toolbarAtMs: 60_000 });
  assert.equal(await ensureCaptionsOn(meet.env), "enabled");
  assert.equal(meet.log.length, 1);
  const clickedAt = Number(meet.log[0].split("@")[1]);
  assert.ok(clickedAt >= 60_000 && clickedAt < 63_000, meet.log[0]);
});

test("a state it cannot read is never acted on; the wait ends with the recording", async () => {
  const meet = page(false, { toolbarAtMs: Infinity, recordingEndsAtMs: 120_000 });
  assert.equal(await ensureCaptionsOn(meet.env), "failed");
  assert.deepEqual(meet.log, []);
  assert.ok(meet.clock() >= 120_000 && meet.clock() < 124_000);
});

test("the setting off: no click, no hint", async () => {
  const meet = page(false);
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
