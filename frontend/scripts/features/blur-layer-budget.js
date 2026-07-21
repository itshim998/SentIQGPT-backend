/* SentIQ Chat — Pass 11.3 blur and layer budgeting runtime */

import {
  BLUR_LAYER_BUDGET_VERSION,
  deriveBlurLayerBudget,
  selectBlurLayerSlots,
  serializeBlurLayerBudget,
} from "./blur-layer-budget-state.mjs";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

const KNOWN_BLUR_SELECTORS = Object.freeze([
  ".sidebar",
  ".chat-input-area",
  ".composer-action-menu",
  ".execution-mode-menu",
  ".auth-menu-panel",
  ".account-panel",
  ".chat-actions-menu",
  ".deep-research-export-menu",
  ".websurf-v2-citation-menu",
  ".websurf-v2-source-explorer-detail",
  ".modal-container",
  ".auth-modal-body",
  ".settings-workspace",
  ".adaptive-panel",
  ".generated-file-panel",
  ".image-generation-card",
  ".message-chart-container",
  ".thinking-panel",
  ".toast",
  ".image-lightbox-toolbar",
  ".live-beta-surface",
  ".live-workspace-surface",
]);

const HIGH_PRIORITY_SELECTOR = [
  ".modal-container",
  ".auth-modal-body",
  ".settings-workspace",
  ".adaptive-panel",
  ".live-beta-surface",
  ".live-workspace-surface",
  ".image-lightbox-toolbar",
].join(",");

const MENU_PRIORITY_SELECTOR = [
  ".composer-action-menu",
  ".execution-mode-menu",
  ".auth-menu-panel",
  ".account-panel",
  ".chat-actions-menu",
  ".deep-research-export-menu",
  ".websurf-v2-citation-menu",
].join(",");

const NEVER_BLUR_SELECTOR = [
  ".sidebar-backdrop",
  ".modal-backdrop",
  ".modal-overlay",
  ".settings-modal",
  ".auth-modal",
  ".name-modal",
  ".adaptive-panel-backdrop",
  ".conversation-continuity-dialog-backdrop",
  ".image-lightbox",
  ".live-beta-panel",
].join(",");

function initializeBlurLayerBudget() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQBlurLayerBudget?.version === BLUR_LAYER_BUDGET_VERSION) return;

  const root = document.documentElement;
  const reducedMotionMedia = window.matchMedia?.(REDUCED_MOTION_QUERY) || null;
  const reducedTransparencyMedia = window.matchMedia?.(REDUCED_TRANSPARENCY_QUERY) || null;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const subscribers = new Set();
  let selectorCache = null;
  let frame = 0;
  let orderCounter = 0;
  let currentState = null;
  let currentSignature = "";

  function supportsBackdropFilter() {
    if (!window.CSS?.supports) return false;
    return (
      window.CSS.supports("backdrop-filter", "blur(1px)")
      || window.CSS.supports("-webkit-backdrop-filter", "blur(1px)")
    );
  }

  function readCapabilities() {
    return {
      width: Math.min(
        window.innerWidth || Number.POSITIVE_INFINITY,
        window.visualViewport?.width || Number.POSITIVE_INFINITY,
      ),
      deviceMemory: navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      saveData: Boolean(connection?.saveData),
      reducedMotion: Boolean(reducedMotionMedia?.matches),
      reducedTransparency: Boolean(reducedTransparencyMedia?.matches),
      backdropSupported: supportsBackdropFilter(),
      mobileGlassProfile: root.dataset.mobileGlassBudgetProfile,
    };
  }

  function splitSelectorList(selectorText) {
    const selectors = [];
    let buffer = "";
    let depth = 0;
    let quote = "";

    for (const character of String(selectorText || "")) {
      if (quote) {
        buffer += character;
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        buffer += character;
        continue;
      }
      if (character === "(" || character === "[") depth += 1;
      if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
      if (character === "," && depth === 0) {
        if (buffer.trim()) selectors.push(buffer.trim());
        buffer = "";
      } else {
        buffer += character;
      }
    }
    if (buffer.trim()) selectors.push(buffer.trim());
    return selectors;
  }

  function queryableSelector(selector) {
    const stripped = String(selector || "")
      .replace(/::[a-zA-Z0-9_-]+(?:\([^)]*\))?/g, "")
      .trim();
    return stripped && stripped !== ":root" && stripped !== "html" && stripped !== "body"
      ? stripped
      : "";
  }

  function ruleUsesBackdrop(rule) {
    const style = rule?.style;
    if (!style?.getPropertyValue) return false;
    const standard = style.getPropertyValue("backdrop-filter").trim();
    const prefixed = style.getPropertyValue("-webkit-backdrop-filter").trim();
    return [standard, prefixed].some((value) => value && value !== "none");
  }

  function collectRuleSelectors(ruleList, target) {
    for (const rule of Array.from(ruleList || [])) {
      if (rule.cssRules) {
        try { collectRuleSelectors(rule.cssRules, target); } catch { /* inaccessible nested rule */ }
      }
      if (!rule.selectorText || !ruleUsesBackdrop(rule)) continue;
      splitSelectorList(rule.selectorText).forEach((selector) => {
        const queryable = queryableSelector(selector);
        if (queryable) target.add(queryable);
      });
    }
  }

  function discoverBlurSelectors() {
    if (selectorCache) return selectorCache;
    const selectors = new Set(KNOWN_BLUR_SELECTORS);
    for (const sheet of Array.from(document.styleSheets || [])) {
      try { collectRuleSelectors(sheet.cssRules, selectors); } catch { /* cross-origin stylesheet */ }
    }
    selectorCache = Object.freeze([...selectors]);
    return selectorCache;
  }

  function collectCandidates() {
    const elements = new Set();
    for (const selector of discoverBlurSelectors()) {
      try { document.querySelectorAll(selector).forEach((element) => elements.add(element)); } catch { /* unsupported selector */ }
    }
    document.querySelectorAll('[data-sentiq-blur-candidate="true"]').forEach((element) => {
      if (element.isConnected) elements.add(element);
    });
    return [...elements].filter((element) => (
      element instanceof HTMLElement
      && element.isConnected
      && !element.matches(NEVER_BLUR_SELECTOR)
    ));
  }

  function isVisible(element, style) {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (Number.parseFloat(style.opacity || "1") <= 0.01) return false;
    return element.getClientRects().length > 0;
  }

  function priorityOf(element, style) {
    let priority = 30;
    if (element.matches(HIGH_PRIORITY_SELECTOR) || element.getAttribute("aria-modal") === "true") priority = 120;
    else if (element.matches(MENU_PRIORITY_SELECTOR)) priority = 105;
    else if (element.matches(".chat-input-area")) priority = 80;
    else if (element.matches(".sidebar")) priority = 70;
    else if (element.matches(".toast, .thinking-panel")) priority = 45;

    if (style.position === "fixed") priority += 16;
    else if (style.position === "sticky") priority += 10;
    else if (style.position === "absolute") priority += 5;

    const zIndex = Number.parseInt(style.zIndex, 10);
    if (Number.isFinite(zIndex)) priority += Math.min(12, Math.max(0, zIndex / 100));
    return priority;
  }

  function annotateCandidates(elements) {
    elements.forEach((element) => {
      element.dataset.sentiqBlurCandidate = "true";
      if (!element.dataset.sentiqBlurOrder) {
        orderCounter += 1;
        element.dataset.sentiqBlurOrder = String(orderCounter);
      }
    });

    return elements.map((element) => {
      const style = window.getComputedStyle(element);
      const parentCandidate = element.parentElement?.closest?.('[data-sentiq-blur-candidate="true"]');
      const nested = Boolean(parentCandidate);
      element.dataset.sentiqBlurNested = nested ? "true" : "false";
      return {
        id: element.dataset.sentiqBlurOrder,
        element,
        visible: isVisible(element, style),
        nested,
        priority: priorityOf(element, style),
        order: Number(element.dataset.sentiqBlurOrder),
      };
    });
  }

  function applyState(reason = "update") {
    const budget = deriveBlurLayerBudget(readCapabilities());
    const candidates = annotateCandidates(collectCandidates());
    const selectedIds = selectBlurLayerSlots(candidates, budget.maxLayers);
    const selectedSet = new Set(selectedIds);
    let activeLayerCount = 0;

    candidates.forEach((candidate) => {
      const selected = selectedSet.has(candidate.id);
      if (selected) {
        activeLayerCount += 1;
        candidate.element.dataset.sentiqBlurSlot = String(activeLayerCount);
        candidate.element.removeAttribute("data-sentiq-blur-fallback");
      } else {
        candidate.element.removeAttribute("data-sentiq-blur-slot");
        candidate.element.dataset.sentiqBlurFallback = !candidate.visible
          ? "hidden"
          : candidate.nested
            ? "nested"
            : budget.staticFallback
              ? "static"
              : "budget";
      }
    });

    root.dataset.sentiqBlurBudgetVersion = BLUR_LAYER_BUDGET_VERSION;
    root.dataset.sentiqBlurProfile = budget.profile;
    root.dataset.sentiqBlurViewport = budget.viewport;
    root.dataset.sentiqBlurMaxLayers = String(budget.maxLayers);
    root.dataset.sentiqBlurActiveLayers = String(activeLayerCount);
    root.style.setProperty("--sentiq-blur-budget-radius", `${budget.blurPx}px`);
    root.style.setProperty("--sentiq-blur-budget-saturation", `${budget.saturationPercent}%`);

    const signature = `${serializeBlurLayerBudget(budget)}|${activeLayerCount}|${selectedIds.join(",")}`;
    currentState = Object.freeze({
      version: BLUR_LAYER_BUDGET_VERSION,
      reason,
      activeLayerCount,
      activeLayerIds: selectedIds,
      ...budget,
    });

    if (signature !== currentSignature || reason === "manual") {
      currentSignature = signature;
      subscribers.forEach((listener) => {
        try { listener(currentState); } catch { /* subscriber isolation */ }
      });
      document.dispatchEvent(new CustomEvent("sentiq-blur-budget-change", { detail: currentState }));
    }
    return currentState;
  }

  function schedule(reason = "update") {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      applyState(reason);
    });
  }

  const observer = new MutationObserver(() => schedule("topology"));
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "open", "style", "aria-hidden", "aria-modal", "data-state"],
  });

  reducedMotionMedia?.addEventListener?.("change", () => schedule("motion-preference"));
  reducedTransparencyMedia?.addEventListener?.("change", () => schedule("transparency-preference"));
  connection?.addEventListener?.("change", () => schedule("connection-capability"));
  window.addEventListener("resize", () => schedule("resize"), { passive: true });
  window.addEventListener("orientationchange", () => schedule("orientation"), { passive: true });
  window.visualViewport?.addEventListener?.("resize", () => schedule("visual-viewport"), { passive: true });
  window.addEventListener("load", () => {
    selectorCache = null;
    schedule("styles-loaded");
  }, { once: true });
  document.addEventListener("sentiq-mobile-glass-budget-change", () => schedule("mobile-budget"));

  applyState("initial");

  window.SentIQBlurLayerBudget = Object.freeze({
    version: BLUR_LAYER_BUDGET_VERSION,
    getState: () => currentState,
    refresh: () => schedule("manual"),
    getActiveLayers: () => [...document.querySelectorAll("[data-sentiq-blur-slot]")],
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false && currentState) listener(currentState);
      return () => subscribers.delete(listener);
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeBlurLayerBudget, { once: true });
} else {
  initializeBlurLayerBudget();
}
