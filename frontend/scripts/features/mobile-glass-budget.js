/* SentIQ Chat — Pass 10.4 mobile density and glass budget */

import {
  MOBILE_GLASS_BUDGET_VERSION,
  deriveMobileGlassBudget,
  serializeMobileGlassBudget,
} from "./mobile-glass-budget-state.mjs";

const MOBILE_QUERY = "(max-width: 768px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function initializeMobileGlassBudget() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQMobileGlassBudget?.version === MOBILE_GLASS_BUDGET_VERSION) return;

  const root = document.documentElement;
  const mobileMedia = window.matchMedia?.(MOBILE_QUERY) || null;
  const reducedMotionMedia = window.matchMedia?.(REDUCED_MOTION_QUERY) || null;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const subscribers = new Set();
  let frame = 0;
  let lastSignature = "";
  let currentState = deriveMobileGlassBudget(readCapabilities());

  function supportsBackdropFilter() {
    if (!window.CSS?.supports) return false;
    return (
      window.CSS.supports("backdrop-filter", "blur(1px)")
      || window.CSS.supports("-webkit-backdrop-filter", "blur(1px)")
    );
  }

  function readCapabilities() {
    const viewportWidth = mobileMedia?.matches
      ? Math.min(window.innerWidth || Number.POSITIVE_INFINITY, window.visualViewport?.width || Number.POSITIVE_INFINITY)
      : (window.innerWidth || document.documentElement.clientWidth || Number.POSITIVE_INFINITY);
    return {
      width: viewportWidth,
      deviceMemory: navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      saveData: Boolean(connection?.saveData),
      reducedMotion: Boolean(reducedMotionMedia?.matches),
      backdropSupported: supportsBackdropFilter(),
    };
  }

  function setData(name, value) {
    if (root.dataset[name] !== String(value)) root.dataset[name] = String(value);
  }

  function applyState(next, reason) {
    const signature = serializeMobileGlassBudget(next);
    if (signature === lastSignature && reason !== "manual") return;
    lastSignature = signature;
    currentState = next;

    setData("mobileGlassBudgetVersion", MOBILE_GLASS_BUDGET_VERSION);
    setData("mobileGlassBudgetProfile", next.profile);
    setData("mobileGlassAtmosphere", next.atmosphere);
    setData("mobileGlassLayers", next.simultaneousGlassLayers);
    setData("mobileGlassOverlayFiltering", next.overlayBackdropFiltering ? "enabled" : "disabled");
    root.classList.toggle("mobile-glass-budget-active", next.mobile);

    if (next.mobile) {
      root.style.setProperty("--sentiq-mobile-glass-blur", `${next.blurPx}px`);
      root.style.setProperty("--sentiq-mobile-glass-saturation", `${next.saturationPercent}%`);
    } else {
      root.style.removeProperty("--sentiq-mobile-glass-blur");
      root.style.removeProperty("--sentiq-mobile-glass-saturation");
    }

    const detail = Object.freeze({
      version: MOBILE_GLASS_BUDGET_VERSION,
      reason,
      ...next,
    });
    subscribers.forEach((listener) => {
      try { listener(detail); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-mobile-glass-budget-change", { detail }));
  }

  function update(reason = "update") {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      applyState(deriveMobileGlassBudget(readCapabilities()), reason);
    });
  }

  mobileMedia?.addEventListener?.("change", () => update("mobile-breakpoint"));
  reducedMotionMedia?.addEventListener?.("change", () => update("motion-preference"));
  connection?.addEventListener?.("change", () => update("connection-capability"));
  window.addEventListener("resize", () => update("resize"), { passive: true });
  window.addEventListener("orientationchange", () => update("orientation"), { passive: true });
  window.visualViewport?.addEventListener?.("resize", () => update("visual-viewport"), { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") update("visibility");
  });

  applyState(currentState, "initial");

  window.SentIQMobileGlassBudget = Object.freeze({
    version: MOBILE_GLASS_BUDGET_VERSION,
    getState: () => currentState,
    refresh: () => update("manual"),
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false) listener(Object.freeze({
        version: MOBILE_GLASS_BUDGET_VERSION,
        reason: "subscribe",
        ...currentState,
      }));
      return () => subscribers.delete(listener);
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMobileGlassBudget, { once: true });
} else {
  initializeMobileGlassBudget();
}
