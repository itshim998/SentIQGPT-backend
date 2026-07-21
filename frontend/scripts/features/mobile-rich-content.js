/* SentIQ Chat — Pass 10.5 mobile rich-content adaptation */

import {
  MOBILE_RICH_CONTENT_VERSION,
  deriveMobileRichLayout,
  serializeMobileRichLayout,
} from "./mobile-rich-content-state.mjs";

const MOBILE_QUERY = "(max-width: 768px)";

function initializeMobileRichContent() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQMobileRichContent?.version === MOBILE_RICH_CONTENT_VERSION) return;

  const root = document.documentElement;
  const body = document.body;
  const mobileMedia = window.matchMedia?.(MOBILE_QUERY) || null;
  const subscribers = new Set();
  let frame = 0;
  let lastSignature = "";
  let currentState = deriveMobileRichLayout({ width: window.innerWidth, height: window.innerHeight });

  const safeAreaProbe = document.createElement("div");
  safeAreaProbe.setAttribute("aria-hidden", "true");
  safeAreaProbe.dataset.mobileRichSafeAreaProbe = "true";
  safeAreaProbe.style.cssText = [
    "position:fixed",
    "inset:-9999px auto auto -9999px",
    "width:0",
    "height:0",
    "visibility:hidden",
    "pointer-events:none",
    "contain:strict",
    "padding-top:env(safe-area-inset-top, 0px)",
    "padding-right:env(safe-area-inset-right, 0px)",
    "padding-bottom:env(safe-area-inset-bottom, 0px)",
    "padding-left:env(safe-area-inset-left, 0px)",
  ].join(";");
  body.appendChild(safeAreaProbe);

  function getVisualViewport() {
    const viewport = window.visualViewport;
    return {
      width: viewport?.width || window.innerWidth || root.clientWidth || 1,
      height: viewport?.height || window.innerHeight || root.clientHeight || 1,
    };
  }

  function getOrientation(viewport) {
    const composerOrientation = root.dataset.mobileComposerOrientation;
    if (composerOrientation === "portrait" || composerOrientation === "landscape") return composerOrientation;
    const screenOrientation = String(window.screen?.orientation?.type || "").toLowerCase();
    if (screenOrientation.includes("landscape")) return "landscape";
    if (screenOrientation.includes("portrait")) return "portrait";
    const legacyOrientation = Number(window.orientation);
    if (Number.isFinite(legacyOrientation)) return Math.abs(legacyOrientation) === 90 ? "landscape" : "portrait";
    return viewport.width > viewport.height ? "landscape" : "portrait";
  }

  function readSafeArea() {
    const style = window.getComputedStyle(safeAreaProbe);
    return {
      safeAreaTop: Number.parseFloat(style.paddingTop) || 0,
      safeAreaRight: Number.parseFloat(style.paddingRight) || 0,
      safeAreaBottom: Number.parseFloat(style.paddingBottom) || 0,
      safeAreaLeft: Number.parseFloat(style.paddingLeft) || 0,
    };
  }

  function readState() {
    const viewport = getVisualViewport();
    return deriveMobileRichLayout({
      width: mobileMedia?.matches ? viewport.width : (window.innerWidth || viewport.width),
      height: viewport.height,
      orientation: getOrientation(viewport),
      keyboardOpen: root.dataset.mobileComposerKeyboard === "open" || body.classList.contains("mobile-composer-keyboard-open"),
      ...readSafeArea(),
    });
  }

  function setData(name, value) {
    if (root.dataset[name] !== String(value)) root.dataset[name] = String(value);
  }

  function setRootProperty(name, value) {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  }

  function applyState(next, reason) {
    const signature = serializeMobileRichLayout(next);
    if (signature === lastSignature && reason !== "manual") return;
    lastSignature = signature;
    currentState = next;

    setData("mobileRichContentVersion", MOBILE_RICH_CONTENT_VERSION);
    setData("mobileRichContentActive", next.mobile ? "true" : "false");
    setData("mobileRichWidth", next.widthClass);
    setData("mobileRichHeight", next.heightClass);
    setData("mobileRichOrientation", next.orientation);
    setData("mobileRichKeyboard", next.keyboardOpen ? "open" : "closed");
    setData("mobileRichSafeArea", next.safeAreaMode);
    body.classList.toggle("mobile-rich-content-active", next.mobile);

    if (next.mobile) {
      setRootProperty("--mobile-rich-viewport-width", `${Math.round(next.contentInlineSize + next.safeAreaLeft + next.safeAreaRight)}px`);
      setRootProperty("--mobile-rich-viewport-height", `${Math.round(getVisualViewport().height)}px`);
      setRootProperty("--mobile-rich-content-inline-size", `${Math.round(next.contentInlineSize)}px`);
      setRootProperty("--mobile-rich-media-max-height", `${Math.round(next.mediaMaxHeight)}px`);
      setRootProperty("--mobile-rich-chart-min-inline-size", `${Math.round(next.chartMinInlineSize)}px`);
      setRootProperty("--mobile-rich-safe-top", `${next.safeAreaTop}px`);
      setRootProperty("--mobile-rich-safe-right", `${next.safeAreaRight}px`);
      setRootProperty("--mobile-rich-safe-bottom", `${next.safeAreaBottom}px`);
      setRootProperty("--mobile-rich-safe-left", `${next.safeAreaLeft}px`);
    }

    const detail = Object.freeze({ version: MOBILE_RICH_CONTENT_VERSION, reason, ...next });
    subscribers.forEach((listener) => {
      try { listener(detail); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-mobile-rich-content-change", { detail }));
  }

  function update(reason = "update") {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      applyState(readState(), reason);
    });
  }

  mobileMedia?.addEventListener?.("change", () => update("mobile-breakpoint"));
  window.addEventListener("resize", () => update("resize"), { passive: true });
  window.addEventListener("orientationchange", () => update("orientation"), { passive: true });
  window.visualViewport?.addEventListener?.("resize", () => update("visual-viewport"), { passive: true });
  window.visualViewport?.addEventListener?.("scroll", () => update("visual-viewport-scroll"), { passive: true });
  document.addEventListener("sentiq-mobile-composer-change", () => update("composer-state"));

  applyState(readState(), "initial");

  window.SentIQMobileRichContent = Object.freeze({
    version: MOBILE_RICH_CONTENT_VERSION,
    getState: () => currentState,
    refresh: () => update("manual"),
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false) listener(Object.freeze({
        version: MOBILE_RICH_CONTENT_VERSION,
        reason: "subscribe",
        ...currentState,
      }));
      return () => subscribers.delete(listener);
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMobileRichContent, { once: true });
} else {
  initializeMobileRichContent();
}
