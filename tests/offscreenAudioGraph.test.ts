import assert from "node:assert/strict";
import test from "node:test";

import {
  createMicrophoneChannelGraph,
  createTabChannelGraph,
  MICROPHONE_AUDIO_CONSTRAINTS,
  OFFSCREEN_ANALYSER_FFT_SIZE,
} from "../src/offscreenAudioGraph.ts";

class MockAudioNode {
  readonly connections: MockAudioNode[] = [];

  connect(destination: MockAudioNode): MockAudioNode {
    this.connections.push(destination);
    return destination;
  }
}

class MockSourceNode extends MockAudioNode {
  constructor(readonly stream: MediaStream) {
    super();
  }
}

class MockAnalyserNode extends MockAudioNode {
  fftSize = 2048;
}

class MockMediaStreamDestinationNode extends MockAudioNode {
  readonly stream = createMockStream("recorder-output");
}

class MockAudioContext {
  readonly destination = new MockAudioNode();
  readonly analysers: MockAnalyserNode[] = [];
  readonly recorderDestinations: MockMediaStreamDestinationNode[] = [];
  readonly sources: MockSourceNode[] = [];

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    const destination = new MockMediaStreamDestinationNode();
    this.recorderDestinations.push(destination);
    return destination as unknown as MediaStreamAudioDestinationNode;
  }

  createAnalyser(): AnalyserNode {
    const analyser = new MockAnalyserNode();
    this.analysers.push(analyser);
    return analyser as unknown as AnalyserNode;
  }

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
    const source = new MockSourceNode(stream);
    this.sources.push(source);
    return source as unknown as MediaStreamAudioSourceNode;
  }
}

function createMockStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

function asAudioContext(context: MockAudioContext): AudioContext {
  return context as unknown as AudioContext;
}

test("the tab channel has its own recorder destination and analyser", () => {
  const context = new MockAudioContext();
  const tabStream = createMockStream("tab");

  const graph = createTabChannelGraph(asAudioContext(context), tabStream);

  assert.equal(context.recorderDestinations.length, 1);
  assert.equal(context.analysers.length, 1);
  assert.equal(graph.destination, context.recorderDestinations[0]);
  assert.equal(graph.analyser, context.analysers[0]);
  assert.equal(graph.source, context.sources[0]);
  assert.equal(context.sources[0].stream, tabStream);
});

test("analysers use the offscreen FFT size", () => {
  const context = new MockAudioContext();
  createTabChannelGraph(asAudioContext(context), createMockStream("tab"));
  createMicrophoneChannelGraph(asAudioContext(context), createMockStream("mic"));
  assert.deepEqual(
    context.analysers.map((analyser) => analyser.fftSize),
    [OFFSCREEN_ANALYSER_FFT_SIZE, OFFSCREEN_ANALYSER_FFT_SIZE],
  );
});

test("tab audio goes to its recorder, its analyser and the playback output", () => {
  const context = new MockAudioContext();
  const graph = createTabChannelGraph(asAudioContext(context), createMockStream("tab"));
  assert.deepEqual(context.sources[0].connections, [
    graph.destination,
    graph.analyser,
    context.destination,
  ]);
});

test("the microphone is recorded and analysed separately, never played back", () => {
  const context = new MockAudioContext();
  const tab = createTabChannelGraph(asAudioContext(context), createMockStream("tab"));
  const mic = createMicrophoneChannelGraph(asAudioContext(context), createMockStream("mic"));

  assert.deepEqual(context.sources[1].connections, [mic.destination, mic.analyser]);
  assert.equal(
    context.sources[1].connections.includes(context.destination),
    false,
    "microphone playback would create local monitoring or feedback",
  );
  assert.notEqual(mic.destination, tab.destination, "each channel has its own recording");
  assert.notEqual(mic.analyser, tab.analyser, "each channel has its own voice detection");
});

test("enables microphone processing and automatic gain control", () => {
  assert.deepEqual(MICROPHONE_AUDIO_CONSTRAINTS, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
});
