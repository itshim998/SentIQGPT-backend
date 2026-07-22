/* SentIQ Liquid Glass V4 — Phase 7.5 message recovery panel */

import { getFailureRecoveryCopy } from "./failure-recovery-state.js";

export function createFailureRecoveryPanel(options) {
  const { chatMessages, chatInput, snapshotManager } = options;
  const retryBindings = new WeakSet();

  function findRetryControls(surface) {
    return Array.from(surface.querySelectorAll("button, [role='button']")).filter((control) => {
      if (control.closest(".failure-recovery-panel")) return false;
      const label = [control.getAttribute("aria-label"), control.title, control.textContent].filter(Boolean).join(" ");
      return /\b(retry|regenerate|continue|resume|try again)\b/i.test(label);
    });
  }

  function bindRetry(control, snapshot, descriptionId) {
    control.dataset.failureRecoveryAction = "true";
    if (descriptionId) control.setAttribute("aria-describedby", descriptionId);
    if (retryBindings.has(control)) return;
    retryBindings.add(control);
    control.addEventListener("click", () => {
      snapshotManager.restoreDraft(snapshot);
      snapshotManager.restoreMode(snapshot);
    }, true);
  }

  function summary(snapshot, draftState, modeState) {
    const attachmentState = snapshotManager.attachmentStatus(snapshot);
    return {
      attachmentState,
      items: [
        ["prompt", "Prompt", "Preserved in this conversation"],
        ["draft", "Draft", draftState === "restored" ? "Restored to the composer" : draftState === "newer" ? "Newer draft left untouched" : "No recoverable text draft"],
        ["attachments", "Attachments", attachmentState === "preserved" ? "Still attached and ready" : attachmentState === "reattach" ? "Reattach local files before retrying" : "No attachments were used"],
        ["mode", "Mode", modeState === "restored" ? "Original mode restored" : modeState === "preserved" ? "Original mode remains active" : modeState === "newer" ? "Newer mode left untouched" : modeState === "available" ? "Original mode can be selected again" : "Standard response mode"],
      ],
    };
  }

  function hasForSnapshot(snapshot) {
    if (!snapshot?.id) return false;
    return Array.from(chatMessages.querySelectorAll(".failure-recovery-panel")).some(
      (panel) => panel.dataset.failureRecoveryRequest === snapshot.id,
    );
  }

  function ensure(surface, tool, state, snapshot) {
    const host = surface.matches(".message.assistant")
      ? surface.querySelector(":scope > .message-content") || surface
      : surface;
    if (!(host instanceof HTMLElement)) return null;
    const copy = getFailureRecoveryCopy(tool, state);
    const signature = `${tool}:${state}:${snapshot?.id || "none"}`;
    let panel = host.querySelector(":scope > .failure-recovery-panel");
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "failure-recovery-panel";
      panel.innerHTML = '<div class="failure-recovery-heading"><span class="failure-recovery-state"></span><strong class="failure-recovery-title"></strong></div><p class="failure-recovery-description"></p><dl class="failure-recovery-preservation"></dl><div class="failure-recovery-actions"></div>';
      host.appendChild(panel);
    }
    if (panel.dataset.signature === signature) {
      const description = panel.querySelector(".failure-recovery-description");
      findRetryControls(surface).forEach((control) => bindRetry(control, snapshot, description?.id || ""));
      return panel;
    }

    panel.dataset.signature = signature;
    panel.dataset.failureRecoveryRequest = snapshot?.id || "";
    panel.dataset.failureRecoveryState = state;
    panel.setAttribute("role", state === "failed" ? "alert" : "status");
    panel.setAttribute("aria-live", "polite");
    const descriptionId = `failure-recovery-${Math.random().toString(36).slice(2, 9)}`;
    panel.querySelector(".failure-recovery-state").textContent = state === "partial" ? "Partial" : state === "cancelled" ? "Cancelled" : "Needs attention";
    panel.querySelector(".failure-recovery-title").textContent = `${copy.label} recovery`;
    const description = panel.querySelector(".failure-recovery-description");
    description.id = descriptionId;
    description.textContent = copy.message;

    const draftState = snapshotManager.restoreDraft(snapshot);
    const modeState = snapshotManager.restoreMode(snapshot);
    const result = summary(snapshot, draftState, modeState);
    panel.querySelector(".failure-recovery-preservation").replaceChildren(...result.items.map(([key, label, value]) => {
      const row = document.createElement("div");
      row.className = "failure-recovery-preservation-row";
      row.dataset.recoveryItem = key;
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      row.append(term, detail);
      return row;
    }));

    const actions = panel.querySelector(".failure-recovery-actions");
    actions.replaceChildren();
    findRetryControls(surface).forEach((control) => bindRetry(control, snapshot, descriptionId));
    if (snapshot?.draft && draftState !== "restored") {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "failure-recovery-restore";
      restore.textContent = "Restore original prompt";
      restore.addEventListener("click", () => {
        snapshotManager.restoreDraft(snapshot, true);
        chatInput.focus();
      });
      actions.appendChild(restore);
    }
    if (result.attachmentState === "reattach") {
      const note = document.createElement("span");
      note.className = "failure-recovery-action-note";
      note.textContent = "Local files are not recreated automatically for safety.";
      actions.appendChild(note);
    }
    return panel;
  }

  return { ensure, hasForSnapshot };
}
