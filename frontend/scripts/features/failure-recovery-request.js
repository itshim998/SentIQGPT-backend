/* SentIQ Liquid Glass V4 — Phase 7.5 recoverable request state */

import {
  getAttachmentRecoveryStatus,
  shouldRestoreComposerDraft,
} from "./failure-recovery-state.js";
import {
  captureFailureRecoveryScroll,
  restoreFailureRecoveryScroll,
} from "./failure-recovery-scroll.js";

const SNAPSHOT_KEY = "sentiq_failure_recovery_snapshot_v7_5";
export const FAILURE_RECOVERY_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function readStored() {
  try {
    const parsed = JSON.parse(window.sessionStorage?.getItem(SNAPSHOT_KEY) || "");
    if (!parsed || Date.now() - Number(parsed.capturedAt || 0) > FAILURE_RECOVERY_SNAPSHOT_MAX_AGE_MS) return null;
    return parsed;
  } catch { return null; }
}

function writeStored(snapshot) {
  if (!snapshot) return;
  const value = {
    id: snapshot.id,
    capturedAt: snapshot.capturedAt,
    draft: snapshot.draft,
    mode: snapshot.mode,
    attachments: snapshot.attachments,
    scroll: snapshot.scroll,
    promptSignature: snapshot.promptSignature || "",
    sourceSignature: snapshot.sourceSignature || "",
    completedAt: Number(snapshot.completedAt || 0),
    restoredKeys: Array.isArray(snapshot.restoredKeys) ? snapshot.restoredKeys.slice(-12) : [],
  };
  try { window.sessionStorage?.setItem(SNAPSHOT_KEY, JSON.stringify(value)); } catch { /* optional recovery memory */ }
}

function isVisible(element) {
  if (!(element instanceof HTMLElement) || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  try { return window.getComputedStyle(element).display !== "none"; } catch { return element.style.display !== "none"; }
}

export function createFailureRecoveryRequestStore(options) {
  const { chatMessages, chatInput, filePreview, chatInputWrapper, modeControls } = options;
  let active = readStored();

  function getActiveMode() {
    if (modeControls["deep-research"]?.getAttribute("aria-pressed") === "true" || isVisible(document.getElementById("deep-research-mode-bar"))) return "deep-research";
    if (modeControls.image?.getAttribute("aria-pressed") === "true" || isVisible(document.getElementById("image-mode-bar"))) return "image";
    if (modeControls.websurf?.getAttribute("aria-pressed") === "true" || isVisible(document.getElementById("web-search-mode-bar"))) return "websurf";
    return "";
  }

  function getAttachmentSnapshot() {
    if (!(filePreview instanceof HTMLElement)) return [];
    return Array.from(filePreview.querySelectorAll(".composer-attachment")).map((card) => ({
      name: clean(card.querySelector(".composer-attachment-name")?.textContent || card.textContent).slice(0, 180),
      state: clean(card.getAttribute("data-attachment-state") || "ready").toLowerCase(),
      family: clean(card.getAttribute("data-file-family") || "file").toLowerCase(),
    })).filter((attachment) => attachment.name);
  }

  function capture(source) {
    chatInputWrapper?.querySelector(":scope > .failure-recovery-tray")?.remove();
    const draft = String(chatInput.value || "");
    const attachments = getAttachmentSnapshot();
    const mode = getActiveMode();
    if (!draft.trim() && attachments.length === 0 && !mode) return null;
    const sourceSignature = `${draft}\u0000${mode}\u0000${attachments.map(({ name }) => name).join("|")}`;
    if (active?.sourceSignature === sourceSignature && !active.completedAt && Date.now() - active.capturedAt < 450) return active;
    active = {
      id: `recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      capturedAt: Date.now(),
      draft,
      mode,
      attachments,
      scroll: captureFailureRecoveryScroll(chatMessages),
      source,
      sourceSignature,
      promptSignature: clean(draft).slice(0, 180),
      restoredKeys: [],
      completedAt: 0,
    };
    writeStored(active);
    return active;
  }

  function restoreMode(snapshot) {
    if (!snapshot?.mode) return "none";
    const current = getActiveMode();
    if (current === snapshot.mode) return "preserved";
    if (current && current !== snapshot.mode) return "newer";
    if (snapshot.attachments?.length) return "available";
    const control = modeControls[snapshot.mode];
    if (!(control instanceof HTMLButtonElement) || control.disabled) return "available";
    control.click();
    return getActiveMode() === snapshot.mode ? "restored" : "available";
  }

  function restoreDraft(snapshot, force = false) {
    if (!snapshot?.draft) return "none";
    if (chatInput.value === snapshot.draft) return "restored";
    if (force || shouldRestoreComposerDraft(chatInput.value, snapshot.draft)) {
      chatInput.value = snapshot.draft;
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      return "restored";
    }
    return "newer";
  }

  function setActive(snapshot) {
    active = snapshot;
    writeStored(snapshot);
  }

  return {
    capture,
    getSnapshot: () => active || readStored(),
    getActiveMode,
    restoreMode,
    restoreDraft,
    restoreScroll: (snapshot) => restoreFailureRecoveryScroll(chatMessages, snapshot),
    attachmentStatus: (snapshot) => getAttachmentRecoveryStatus(
      snapshot?.attachments?.length || 0,
      filePreview?.querySelectorAll(".composer-attachment").length || 0,
    ),
    setActive,
    maxAgeMs: FAILURE_RECOVERY_SNAPSHOT_MAX_AGE_MS,
  };
}
