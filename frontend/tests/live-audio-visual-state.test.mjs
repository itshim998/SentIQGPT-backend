import assert from "node:assert/strict";
import {
  LIVE_AUDIO_VISUAL_VERSION,
  LIVE_PCM_EVENT_INTERVAL_MS,
  deriveLiveVisualFrame,
  emitLivePcmLevel,
  measurePcmRms,
  normalizeLivePcmLevel,
  resetLivePcmEmitterState,
  selectLiveVisualLevel,
  smoothLivePcmLevel,
} from "../scripts/features/live/live-audio-visual-state.mjs";

assert.equal(LIVE_AUDIO_VISUAL_VERSION, "13.2");
assert.equal(LIVE_PCM_EVENT_INTERVAL_MS, 32);
assert.equal(measurePcmRms(new Float32Array([0, 0, 0, 0])), 0);
assert.ok(Math.abs(measurePcmRms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 0.0001);
assert.equal(normalizeLivePcmLevel(0.005), 0);
assert.equal(normalizeLivePcmLevel(0.24), 1);

const attack = smoothLivePcmLevel(0.1, 0.8);
const release = smoothLivePcmLevel(0.8, 0.1);
assert.ok(attack > 0.45, "attack should react quickly to speech");
assert.ok(release > 0.6, "release should decay more slowly than attack");

assert.deepEqual(selectLiveVisualLevel({
  state: "muted",
  inputLevel: 1,
  inputFresh: true,
}), { level: 0, direction: "idle" });
assert.deepEqual(selectLiveVisualLevel({
  state: "listening",
  inputLevel: 0.7,
  outputLevel: 0.2,
  inputFresh: true,
  outputFresh: true,
}), { level: 0.7, direction: "input" });
assert.deepEqual(selectLiveVisualLevel({
  state: "speaking",
  inputLevel: 0.1,
  outputLevel: 0.8,
  inputFresh: true,
  outputFresh: true,
}), { level: 0.8, direction: "output" });

const quiet = deriveLiveVisualFrame(0, "idle");
const speaking = deriveLiveVisualFrame(0.8, "output");
assert.equal(quiet.waveScales.length, 5);
assert.ok(speaking.orbScale > quiet.orbScale);
assert.ok(speaking.glowOpacity > quiet.glowOpacity);
assert.ok(speaking.waveScales[2] > speaking.waveScales[0]);
assert.ok(speaking.ringOneOpacity > quiet.ringOneOpacity);

resetLivePcmEmitterState();
const first = emitLivePcmLevel("input", new Float32Array([0.3, -0.3]), 0);
const peak = emitLivePcmLevel("input", new Float32Array([0.6, -0.6]), 40);
assert.ok(first > 0);
assert.ok(peak >= first, "throttled emitter should preserve the stronger pending peak");

console.log("Live PCM visual state passed: real input/output amplitude is normalized, peak-throttled, smoothed, and mapped to stable compositor values.");
