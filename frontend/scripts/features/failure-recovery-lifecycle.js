/* SentIQ Liquid Glass V4 — Phase 7.5 recovery lifecycle */

import { inferFailureRecoveryTool } from "./failure-recovery-state.js";
import { FAILURE_RECOVERY_SURFACE_SELECTOR } from "./failure-recovery-surface.js";

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function startFailureRecoveryLifecycle(options) {
  const { chatMessages, chatInput, toastContainer, snapshots, view, enhanceSurface } = options;
  const pending = new Set();
  let frame = 0;

  function flush() {
    frame = 0;
    const surfaces = Array.from(pending);
    pending.clear();
    surfaces.forEach(enhanceSurface);
  }

  function collect(node) {
    const element = node instanceof HTMLElement ? node : node?.parentElement;
    if (!(element instanceof HTMLElement)) return;
    if (element.closest(".failure-recovery-panel")) return;
    if (element.matches(".message.user")) snapshots.associateUserMessage(element);
    element.querySelectorAll?.(".message.user").forEach(snapshots.associateUserMessage);
    if (element.matches(FAILURE_RECOVERY_SURFACE_SELECTOR)) pending.add(element);
    const closest = element.closest(FAILURE_RECOVERY_SURFACE_SELECTOR);
    if (closest) pending.add(closest);
    element.querySelectorAll?.(FAILURE_RECOVERY_SURFACE_SELECTOR).forEach((surface) => pending.add(surface));
    if (!frame && pending.size) frame = window.requestAnimationFrame(flush);
  }

  function scheduleToastRecovery(toast) {
    if (!(toast instanceof HTMLElement)) return;
    const snapshot = snapshots.getSnapshot();
    if (!snapshot || Date.now() - Number(snapshot.capturedAt || 0) > snapshots.maxAgeMs || snapshot.completedAt) return;
    const text = clean(toast.textContent);
    const classes = clean(toast.className).toLowerCase();
    if (!/error|failed|failure|couldn'?t|could not|unable|try again|stopped/i.test(`${classes} ${text}`)) return;
    window.setTimeout(() => {
      if (view.hasRecoveryForSnapshot(snapshot)) return;
      const tool = snapshot.mode || inferFailureRecoveryTool({ text, classes });
      view.ensureComposerTray(snapshot, tool, /stopped|cancelled|canceled/i.test(text) ? "cancelled" : "failed", text);
    }, 220);
  }

  function scheduleCancelledRecovery() {
    const snapshot = snapshots.getSnapshot();
    if (!snapshot || snapshot.completedAt) return;
    window.setTimeout(() => {
      if (view.hasRecoveryForSnapshot(snapshot)) return;
      view.ensureComposerTray(snapshot, snapshot.mode || "response", "cancelled");
    }, 260);
  }

  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("#send-btn") : null;
    if (!button) return;
    const label = [button.getAttribute("aria-label"), button.title, button.className, button.textContent]
      .filter(Boolean).join(" ");
    if (/\b(stop|cancel)\b/i.test(label)) scheduleCancelledRecovery();
    else snapshots.capture("send-button");
  }, true);

  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) snapshots.capture("keyboard-send");
  }, true);

  if (toastContainer instanceof HTMLElement) {
    new MutationObserver((records) => records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        const toast = node instanceof HTMLElement ? node : node?.parentElement;
        if (toast) scheduleToastRecovery(toast);
      });
    })).observe(toastContainer, { childList: true, subtree: true });
  }

  new MutationObserver((records) => records.forEach((record) => {
    if (record.type === "attributes" && record.target instanceof Element && record.target.closest(".failure-recovery-panel")) return;
    collect(record.target);
    record.addedNodes.forEach(collect);
  })).observe(chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "aria-busy", "data-response-status", "data-asset-result-state", "data-deep-research-status"],
  });

  collect(chatMessages);
}
