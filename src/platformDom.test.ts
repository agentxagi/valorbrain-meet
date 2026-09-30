import test from "node:test";
import assert from "node:assert/strict";

import { micMutedFromLabel, PLATFORM_DOM, splitDisplayName } from "./platformDom.ts";

test("every platform has chat, participant and leave selectors", () => {
  for (const [platform, dom] of Object.entries(PLATFORM_DOM)) {
    assert.ok(dom.chatInput.length > 0, `${platform}: chat input`);
    assert.ok(dom.sendButton.length > 0, `${platform}: send button`);
    assert.ok(dom.participantNodes.length > 0, `${platform}: participants`);
    assert.ok(dom.micButtons.length > 0, `${platform}: microphone`);
    assert.ok(dom.postCallTexts instanceof RegExp, `${platform}: leave screen`);
    if (platform !== "meet") assert.ok(dom.inCallIndicators.length > 0, `${platform}: in-call UI`);
  }
});

test("the post-call screens are recognized in PT-BR and English", () => {
  assert.ok(PLATFORM_DOM.zoom.postCallTexts.test("This meeting has been ended by host"));
  assert.ok(PLATFORM_DOM.zoom.postCallTexts.test("Você saiu da reunião"));
  assert.ok(PLATFORM_DOM.zoom.postCallPath?.test("/wc/85012345678/leave"));
  assert.ok(!PLATFORM_DOM.zoom.postCallPath?.test("/wc/85012345678/join"));
  assert.ok(PLATFORM_DOM.teams.postCallTexts.test("You left the meeting"));
  assert.ok(PLATFORM_DOM.teams.postCallLabels.test("Reingressar"));
  assert.ok(PLATFORM_DOM.meet.postCallLabels.test("Participar novamente"));
});

test("the microphone state is read from what a click on the toggle would do", () => {
  assert.equal(micMutedFromLabel("unmute my microphone"), true);
  assert.equal(micMutedFromLabel("mute my microphone"), false);
  assert.equal(micMutedFromLabel("Unmute (Ctrl+Shift+M)"), true);
  assert.equal(micMutedFromLabel("Mute (Ctrl+Shift+M)"), false);
  assert.equal(micMutedFromLabel("Desativar mudo (Ctrl+Shift+M)"), true);
  assert.equal(micMutedFromLabel("Ativar mudo (Ctrl+Shift+M)"), false);
  assert.equal(micMutedFromLabel("Ativar microfone"), true);
  assert.equal(
    micMutedFromLabel("Desativar microfone"),
    false,
    "'ativar' inside 'desativar' is not a match",
  );
  assert.equal(micMutedFromLabel("Compartilhar tela"), null);
  assert.equal(micMutedFromLabel(""), null);
});

test("Zoom/Teams name markers are removed and the local user is recognized", () => {
  assert.deepEqual(splitDisplayName("Ana Souza (Host, me)"), { name: "Ana Souza", isSelf: true });
  assert.deepEqual(splitDisplayName("Gustavo (Você)"), { name: "Gustavo", isSelf: true });
  assert.deepEqual(splitDisplayName("Bruno Lima (Convidado)"), {
    name: "Bruno Lima",
    isSelf: false,
  });
  assert.deepEqual(splitDisplayName("Carla (Guest) (Unverified)"), {
    name: "Carla",
    isSelf: false,
  });
  assert.deepEqual(splitDisplayName("  Diego   Braga "), { name: "Diego Braga", isSelf: false });
  assert.deepEqual(splitDisplayName("Eva (Mentor da equipe)"), { name: "Eva", isSelf: false });
});
