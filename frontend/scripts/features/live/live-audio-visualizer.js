import {
  LIVE_AUDIO_STALE_MS,
  LIVE_AUDIO_VISUAL_VERSION,
  deriveLiveVisualFrame,
  selectLiveVisualLevel,
  smoothLivePcmLevel,
} from "./live-audio-visual-state.mjs";

const FRAME_INTERVAL_MS = 32;
const ACTIVE_STATES = new Set(["listening", "speaking"]);
const RESET_STATES = new Set([
  "muted",
  "ended",
  "error",
  "quota_denied",
  "mic_blocked",
  "websocket_failed",
  "audio_failed",
  "unavailable",
]);

function initializeLiveAudioVisualizer() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQLiveAudioVisualizer?.version === LIVE_AUDIO_VISUAL_VERSION) return;

  const panel = document.getElementById("live-beta-panel");
  if (!(panel instanceof HTMLElement)) return;

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce), (update: slow)") || { matches: false };
  let inputLevel = 0;
  let outputLevel = 0;
  let inputAt = 0;
  let outputAt = 0;
  let renderedLevel = 0;
  let frameId = 0;
  let lastFrameAt = 0;

  panel.dataset.liveAudioReactive = LIVE_AUDIO_VISUAL_VERSION;

  function currentState() {
    return String(panel.dataset.state || "connecting");
  }

  function isMuted() {
    return currentState() === "muted"
      || document.getElementById("live-beta-mute")?.getAttribute("aria-pressed") === "true";
  }

  function applyFrame(frame) {
    panel.dataset.liveAudioDirection = frame.direction;
    panel.style.setProperty("--live-audio-level", frame.level.toFixed(4));
    panel.style.setProperty("--live-orb-scale", frame.orbScale.toFixed(4));
    panel.style.setProperty("--live-ring-one-scale", frame.ringOneScale.toFixed(4));
    panel.style.setProperty("--live-ring-two-scale", frame.ringTwoScale.toFixed(4));
    panel.style.setProperty("--live-glow-opacity", frame.glowOpacity.toFixed(4));
    panel.style.setProperty("--live-glow-scale", frame.glowScale.toFixed(4));
    frame.waveScales.forEach((scale, index) => {
      panel.style.setProperty(`--live-wave-scale-${index + 1}`, scale.toFixed(4));
    });
  }

  function applyRestingFrame() {
    renderedLevel = 0;
    applyFrame(deriveLiveVisualFrame(0, "idle"));
  }

  function stopLoop() {
    if (frameId) window.cancelAnimationFrame(frameId);
    frameId = 0;
    lastFrameAt = 0;
  }

  function reset() {
    stopLoop();
    inputLevel = 0;
    outputLevel = 0;
    inputAt = 0;
    outputAt = 0;
    applyRestingFrame();
  }

  function schedule() {
    if (!frameId && !reducedMotion.matches) frameId = window.requestAnimationFrame(tick);
  }

  function tick(timestamp) {
    frameId = 0;
    if ((timestamp - lastFrameAt) < FRAME_INTERVAL_MS) {
      schedule();
      return;
    }
    lastFrameAt = timestamp;

    const state = currentState();
    const now = window.performance?.now?.() ?? Date.now();
    if (!ACTIVE_STATES.has(state) || panel.hidden || panel.getAttribute("aria-hidden") === "true") {
      reset();
      return;
    }

    const inputFresh = (now - inputAt) <= LIVE_AUDIO_STALE_MS;
    const outputFresh = (now - outputAt) <= LIVE_AUDIO_STALE_MS;
    if (!inputFresh) inputLevel *= 0.7;
    if (!outputFresh) outputLevel *= 0.7;

    const selected = selectLiveVisualLevel({
      state,
      muted: isMuted(),
      inputLevel,
      outputLevel,
      inputFresh: inputFresh || inputLevel > 0.004,
      outputFresh: outputFresh || outputLevel > 0.004,
    });
    renderedLevel = smoothLivePcmLevel(renderedLevel, selected.level);
    applyFrame(deriveLiveVisualFrame(renderedLevel, selected.direction));

    const stillActive = renderedLevel > 0.003 || inputLevel > 0.003 || outputLevel > 0.003;
    if (stillActive) schedule();
    else applyRestingFrame();
  }

  function handleLevel(event) {
    if (reducedMotion.matches) return;
    const detail = event?.detail || {};
    const level = Math.min(1, Math.max(0, Number(detail.level) || 0));
    const at = Number(detail.at) || (window.performance?.now?.() ?? Date.now());
    if (detail.direction === "output") {
      outputLevel = Math.max(outputLevel * 0.72, level);
      outputAt = at;
    } else {
      inputLevel = Math.max(inputLevel * 0.72, level);
      inputAt = at;
    }
    if (ACTIVE_STATES.has(currentState()) && !isMuted()) schedule();
  }

  function syncState() {
    const state = currentState();
    panel.dataset.liveAudioState = state;
    if (RESET_STATES.has(state) || panel.hidden || panel.getAttribute("aria-hidden") === "true") {
      reset();
      return;
    }
    if (!ACTIVE_STATES.has(state)) applyRestingFrame();
  }

  document.addEventListener("sentiq-live-pcm-level", handleLevel);
  const observer = new MutationObserver(syncState);
  observer.observe(panel, {
    attributes: true,
    attributeFilter: ["data-state", "hidden", "aria-hidden"],
  });
  reducedMotion.addEventListener?.("change", reset);
  window.addEventListener("pagehide", reset, { passive: true });
  syncState();

  window.SentIQLiveAudioVisualizer = Object.freeze({
    version: LIVE_AUDIO_VISUAL_VERSION,
    getLevel: () => renderedLevel,
    reset,
    sync: syncState,
  });
}

initializeLiveAudioVisualizer();
