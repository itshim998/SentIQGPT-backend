/* SentIQ Chat — Pass 11.2 compositor-safe transition runtime */

import {
  COMPOSITOR_SAFE_PROPERTIES,
  COMPOSITOR_SAFETY_VERSION,
  deriveCompositorPolicy,
  normalizeCompositorProperties,
  toCompositorProgressScale,
} from "./compositor-safety-state.mjs";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const SLOW_UPDATE_QUERY = "(update: slow)";

function initializeCompositorSafety() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQCompositorSafety?.version === COMPOSITOR_SAFETY_VERSION) return;

  const root = document.documentElement;
  const reducedMotionMedia = window.matchMedia?.(REDUCED_MOTION_QUERY) || null;
  const slowUpdateMedia = window.matchMedia?.(SLOW_UPDATE_QUERY) || null;
  const connection = window.navigator?.connection || null;
  const subscribers = new Set();
  let currentPolicy = "full";

  function readPolicy() {
    return deriveCompositorPolicy({
      prefersReducedMotion: Boolean(reducedMotionMedia?.matches),
      slowUpdate: Boolean(slowUpdateMedia?.matches),
      saveData: Boolean(connection?.saveData),
    });
  }

  function detail(reason) {
    return Object.freeze({
      version: COMPOSITOR_SAFETY_VERSION,
      policy: currentPolicy,
      properties: COMPOSITOR_SAFE_PROPERTIES,
      reason,
    });
  }

  function notify(reason) {
    const payload = detail(reason);
    subscribers.forEach((listener) => {
      try { listener(payload); } catch { /* isolate optional listeners */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-compositor-policy-change", { detail: payload }));
  }

  function applyPolicy(reason = "update") {
    const nextPolicy = readPolicy();
    const changed = currentPolicy !== nextPolicy
      || root.dataset.sentiqCompositorVersion !== COMPOSITOR_SAFETY_VERSION;

    currentPolicy = nextPolicy;
    root.dataset.sentiqCompositorVersion = COMPOSITOR_SAFETY_VERSION;
    root.dataset.sentiqCompositorPolicy = currentPolicy;

    if (changed || reason === "manual") notify(reason);
    return currentPolicy;
  }

  function setProgress(element, percent) {
    if (!element?.style?.setProperty) return false;
    const scale = toCompositorProgressScale(percent);
    element.style.setProperty("--sentiq-progress-scale", String(scale));
    return true;
  }

  reducedMotionMedia?.addEventListener?.("change", () => applyPolicy("reduced-motion"));
  slowUpdateMedia?.addEventListener?.("change", () => applyPolicy("update-capability"));
  connection?.addEventListener?.("change", () => applyPolicy("connection"));

  applyPolicy("initial");

  window.SentIQCompositorSafety = Object.freeze({
    version: COMPOSITOR_SAFETY_VERSION,
    properties: COMPOSITOR_SAFE_PROPERTIES,
    getPolicy: () => currentPolicy,
    refresh: () => applyPolicy("manual"),
    normalizeProperties: normalizeCompositorProperties,
    progressScale: toCompositorProgressScale,
    setProgress,
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false) listener(detail("subscribe"));
      return () => subscribers.delete(listener);
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeCompositorSafety, { once: true });
} else {
  initializeCompositorSafety();
}
