export const LIVE_AUDIO_VISUAL_VERSION = "13.2";
export const LIVE_PCM_EVENT_INTERVAL_MS = 32;
export const LIVE_AUDIO_STALE_MS = 128;

const emitState = {
  input: { lastAt: 0, peak: 0 },
  output: { lastAt: 0, peak: 0 },
};

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

export function measurePcmRms(samples) {
  if (!samples || typeof samples.length !== "number" || samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(Number(samples[index]) || 0, -1, 1);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export function normalizeLivePcmLevel(rms, options = {}) {
  const noiseFloor = Number.isFinite(options.noiseFloor) ? options.noiseFloor : 0.012;
  const speechCeiling = Number.isFinite(options.speechCeiling) ? options.speechCeiling : 0.24;
  const range = Math.max(0.001, speechCeiling - noiseFloor);
  const normalized = clamp((Math.max(0, Number(rms) || 0) - noiseFloor) / range);
  return clamp(Math.pow(normalized, 0.72));
}

export function smoothLivePcmLevel(current, target, options = {}) {
  const safeCurrent = clamp(current);
  const safeTarget = clamp(target);
  const attack = clamp(options.attack ?? 0.58);
  const release = clamp(options.release ?? 0.16);
  const factor = safeTarget > safeCurrent ? attack : release;
  return clamp(safeCurrent + (safeTarget - safeCurrent) * factor);
}

export function selectLiveVisualLevel({
  state,
  muted = false,
  inputLevel = 0,
  outputLevel = 0,
  inputFresh = false,
  outputFresh = false,
} = {}) {
  if (muted || !["listening", "speaking"].includes(String(state || ""))) {
    return { level: 0, direction: "idle" };
  }
  const input = inputFresh ? clamp(inputLevel) : 0;
  const output = outputFresh ? clamp(outputLevel) : 0;
  if (input > output * 1.08) return { level: input, direction: "input" };
  if (output > 0) return { level: output, direction: "output" };
  if (input > 0) return { level: input, direction: "input" };
  return { level: 0, direction: "idle" };
}

export function deriveLiveVisualFrame(level, direction = "idle") {
  const safeLevel = clamp(level);
  const emphasis = direction === "output" ? 1.08 : direction === "input" ? 1 : 0.7;
  const weighted = clamp(safeLevel * emphasis);
  const waveWeights = [0.56, 0.82, 1, 0.78, 0.52];
  return {
    level: weighted,
    direction,
    orbScale: 1 + weighted * 0.075,
    ringOneScale: 0.992 + weighted * 0.052,
    ringTwoScale: 0.988 + weighted * 0.036,
    glowOpacity: 0.1 + weighted * 0.42,
    glowScale: 0.96 + weighted * 0.18,
    waveScales: waveWeights.map((weight) => clamp(0.28 + weighted * weight * 1.22, 0.24, 1.45)),
  };
}

export function emitLivePcmLevel(direction, samples, nowOverride) {
  const normalizedDirection = direction === "output" ? "output" : "input";
  const level = normalizeLivePcmLevel(measurePcmRms(samples));
  const state = emitState[normalizedDirection];
  state.peak = Math.max(state.peak, level);
  const now = Number.isFinite(nowOverride)
    ? Number(nowOverride)
    : (globalThis.performance?.now?.() ?? Date.now());
  if ((now - state.lastAt) < LIVE_PCM_EVENT_INTERVAL_MS) return level;
  const peak = state.peak;
  state.peak = 0;
  state.lastAt = now;
  if (typeof document !== "undefined" && typeof CustomEvent === "function") {
    document.dispatchEvent(new CustomEvent("sentiq-live-pcm-level", {
      detail: { direction: normalizedDirection, level: peak, at: now },
    }));
  }
  return peak;
}

export function resetLivePcmEmitterState() {
  emitState.input.lastAt = 0;
  emitState.input.peak = 0;
  emitState.output.lastAt = 0;
  emitState.output.peak = 0;
}
