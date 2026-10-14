import test from "node:test";
import assert from "node:assert/strict";

import { CaptionSpeakerTracker, captionSpeakerName, type CaptionNode } from "./meetCaptions.ts";

interface FakeNode {
  textContent: string | null;
  previousElementSibling: FakeNode | null;
  parentElement: FakeNode | null;
}

function node(textContent: string, parentElement: FakeNode | null = null): FakeNode {
  return { textContent, previousElementSibling: null, parentElement };
}

/** One caption block as Meet draws it: the speaker's name, then the words. */
function captionBlock(region: FakeNode, speaker: string, words: string) {
  const block = node(`${speaker}${words}`, region);
  const name = node(speaker, block);
  const text = node(words, block);
  text.previousElementSibling = name;
  return { block, name, text };
}

const asCaption = (n: FakeNode) => n as CaptionNode;

test("each new caption block is a turn of the speaker it names", () => {
  const region = node("");
  const tracker = new CaptionSpeakerTracker();
  const edgar = captionBlock(region, "Edgar Fonseca | EVOUS", "A gente manda a análise");
  assert.equal(tracker.turn(asCaption(edgar.text)), "Edgar Fonseca | EVOUS");
  // Edgar keeps talking: Meet rewrites the same block.
  edgar.text.textContent += " de uso do produto semana que vem.";
  assert.equal(tracker.turn(asCaption(edgar.text)), null);

  // The user's own turn reads "Você" / "You": it is a turn too.
  const you = captionBlock(region, "Você", "Então o primeiro passo é o piloto.");
  assert.equal(tracker.turn(asCaption(you.text)), "Você");

  // Meet corrects a word in Edgar's earlier block: not a new turn.
  edgar.text.textContent = "A gente manda a análise de uso do produto na semana que vem.";
  assert.equal(tracker.turn(asCaption(edgar.text)), null);

  // Edgar again, in a new block.
  const edgarAgain = captionBlock(region, "Edgar Fonseca | EVOUS", "Combinado.");
  assert.equal(tracker.turn(asCaption(edgarAgain.text)), "Edgar Fonseca | EVOUS");
});

test("a block becomes a turn only once it has words", () => {
  const tracker = new CaptionSpeakerTracker();
  const ana = captionBlock(node(""), "Ana Souza", "");
  assert.equal(tracker.turn(asCaption(ana.text)), null);
  ana.text.textContent = "Bom dia.";
  assert.equal(tracker.turn(asCaption(ana.text)), "Ana Souza");
});

test("text above a caption that is not a name is not a speaker", () => {
  const tracker = new CaptionSpeakerTracker();
  const region = node("");
  // The region's own heading or a sentence above the words.
  for (const above of ["", "more_vert", "Isso foi o que eu disse na reunião de ontem."]) {
    const block = captionBlock(region, above, "Texto da legenda.");
    assert.equal(tracker.turn(asCaption(block.text)), null, JSON.stringify(above));
  }
  // An element with nothing before it, or without a parent.
  assert.equal(tracker.turn(asCaption(node("solto"))), null);
  assert.equal(tracker.turn(null), null);
});

test("caption speaker names lose Meet's markers and keep the self label", () => {
  assert.equal(captionSpeakerName("  Gustavo   Iucksh Santos "), "Gustavo Iucksh Santos");
  assert.equal(
    captionSpeakerName("Gustavo Iucksh Santos (Your Presentation)"),
    "Gustavo Iucksh Santos",
  );
  assert.equal(captionSpeakerName("You"), "You");
  assert.equal(captionSpeakerName("Você"), "Você");
  assert.equal(
    captionSpeakerName("Fala de alguém que é longa demais para ser um nome de pessoa"),
    null,
  );
});
