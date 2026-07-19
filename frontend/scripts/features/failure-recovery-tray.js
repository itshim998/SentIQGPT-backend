/* SentIQ Liquid Glass V4 — Phase 7.5 composer recovery tray */

import { getFailureRecoveryCopy } from "./failure-recovery-state.js";

export function createFailureRecoveryTray(options) {
  const { chatInput, chatInputWrapper, snapshotManager } = options;

  function ensure(snapshot, tool, state = "failed", sourceText = "") {
    if (!(chatInputWrapper instanceof HTMLElement) || !snapshot) return null;
    const copy = getFailureRecoveryCopy(tool, state);
    let tray = chatInputWrapper.querySelector(":scope > .failure-recovery-tray");
    if (!tray) {
      tray = document.createElement("section");
      tray.className = "failure-recovery-tray";
      tray.innerHTML = '<div class="failure-recovery-tray-copy"><strong class="failure-recovery-tray-title"></strong><span class="failure-recovery-tray-description"></span></div><button type="button" class="failure-recovery-tray-action">Review and retry</button><button type="button" class="failure-recovery-tray-close" aria-label="Dismiss recovery notice">×</button>';
      chatInputWrapper.insertBefore(tray, chatInputWrapper.firstChild);
      tray.querySelector(".failure-recovery-tray-action")?.addEventListener("click", () => {
        const current = tray._failureRecoverySnapshot;
        snapshotManager.restoreDraft(current);
        snapshotManager.restoreMode(current);
        chatInput.focus();
      });
      tray.querySelector(".failure-recovery-tray-close")?.addEventListener("click", () => tray.remove());
    }
    tray._failureRecoverySnapshot = snapshot;
    tray.dataset.failureRecoveryRequest = snapshot.id || "";
    tray.dataset.failureRecoveryState = state;
    tray.dataset.failureRecoveryTool = tool;
    tray.setAttribute("role", state === "failed" ? "alert" : "status");
    tray.setAttribute("aria-live", "polite");
    tray.querySelector(".failure-recovery-tray-title").textContent = `${copy.label} ${state === "cancelled" ? "stopped" : "needs attention"}`;
    tray.querySelector(".failure-recovery-tray-description").textContent = sourceText
      ? `${copy.message} ${String(sourceText).replace(/\s+/g, " ").trim().slice(0, 160)}`
      : copy.message;
    snapshotManager.restoreDraft(snapshot);
    snapshotManager.restoreMode(snapshot);
    snapshotManager.restoreScroll(snapshot);
    return tray;
  }

  return {
    ensure,
    clear: () => chatInputWrapper?.querySelector(":scope > .failure-recovery-tray")?.remove(),
  };
}
