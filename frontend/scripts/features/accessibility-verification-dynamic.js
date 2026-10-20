/* SentIQ Chat — Phase 12.1 direct dynamic accessibility roots */

function initializeAccessibilityDynamicBridge() {
  if (typeof document === "undefined" || !document.body) return;
  if (document.documentElement.dataset.accessibilityDynamicBridge === "12.1") return;
  document.documentElement.dataset.accessibilityDynamicBridge = "12.1";

  const executionToggle = document.getElementById("execution-mode-toggle");
  if (executionToggle instanceof HTMLElement) {
    executionToggle.setAttribute("aria-label", "Execution mode");
  }

  const pending = new Set();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const scopes = Array.from(pending);
    pending.clear();
    scopes.forEach((scope) => window.SentIQAccessibility?.enhance?.(scope));
  };
  const schedule = (scope) => {
    if (scope instanceof Element) pending.add(scope);
    if (!frame) frame = window.requestAnimationFrame(flush);
  };

  new MutationObserver((records) => {
    records.forEach((record) => schedule(record.target));
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAccessibilityDynamicBridge, { once: true });
} else {
  initializeAccessibilityDynamicBridge();
}
