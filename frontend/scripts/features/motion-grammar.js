/* SentIQ Chat — Pass 11.1 motion grammar runtime */

import {
  MOTION_FAMILIES,
  MOTION_GRAMMAR_VERSION,
  createMotionDescriptor,
  deriveMotionPolicy,
} from "./motion-grammar-state.mjs";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const SLOW_UPDATE_QUERY = "(update: slow)";

function initializeMotionGrammar() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQMotionGrammar?.version === MOTION_GRAMMAR_VERSION) return;

  const root = document.documentElement;
  const reducedMotionMedia = window.matchMedia?.(REDUCED_MOTION_QUERY) || null;
  const slowUpdateMedia = window.matchMedia?.(SLOW_UPDATE_QUERY) || null;
  const subscribers = new Set();
  let currentPolicy = "full";

  function readPolicy() {
    return deriveMotionPolicy({
      prefersReducedMotion: Boolean(reducedMotionMedia?.matches),
      slowUpdate: Boolean(slowUpdateMedia?.matches),
    });
  }

  function notify(reason) {
    const detail = Object.freeze({
      version: MOTION_GRAMMAR_VERSION,
      policy: currentPolicy,
      families: MOTION_FAMILIES,
      reason,
    });

    subscribers.forEach((listener) => {
      try { listener(detail); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-motion-policy-change", { detail }));
  }

  function applyPolicy(reason = "update") {
    const nextPolicy = readPolicy();
    const changed = currentPolicy !== nextPolicy
      || root.dataset.sentiqMotionVersion !== MOTION_GRAMMAR_VERSION;

    currentPolicy = nextPolicy;
    root.dataset.sentiqMotionVersion = MOTION_GRAMMAR_VERSION;
    root.dataset.sentiqMotionPolicy = currentPolicy;

    if (changed || reason === "manual") notify(reason);
    return currentPolicy;
  }

  function mark(element, family, options = {}) {
    if (!(element instanceof HTMLElement)) return false;
    const descriptor = createMotionDescriptor(family, options);
    if (!descriptor) return false;

    element.dataset.sentiqMotionFamily = descriptor.family;
    if (descriptor.phase) element.dataset.sentiqMotionPhase = descriptor.phase;
    else element.removeAttribute("data-sentiq-motion-phase");
    return true;
  }

  function clear(element) {
    if (!(element instanceof HTMLElement)) return false;
    element.removeAttribute("data-sentiq-motion-family");
    element.removeAttribute("data-sentiq-motion-phase");
    return true;
  }

  reducedMotionMedia?.addEventListener?.("change", () => applyPolicy("reduced-motion"));
  slowUpdateMedia?.addEventListener?.("change", () => applyPolicy("update-capability"));

  applyPolicy("initial");

  window.SentIQMotionGrammar = Object.freeze({
    version: MOTION_GRAMMAR_VERSION,
    families: MOTION_FAMILIES,
    getPolicy: () => currentPolicy,
    refresh: () => applyPolicy("manual"),
    mark,
    clear,
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false) {
        listener(Object.freeze({
          version: MOTION_GRAMMAR_VERSION,
          policy: currentPolicy,
          families: MOTION_FAMILIES,
          reason: "subscribe",
        }));
      }
      return () => subscribers.delete(listener);
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMotionGrammar, { once: true });
} else {
  initializeMotionGrammar();
}
