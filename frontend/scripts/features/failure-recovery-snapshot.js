/* SentIQ Liquid Glass V4 — Phase 7.5 request association */

import { createFailureRecoveryRequestStore } from "./failure-recovery-request.js";

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function nearestUserMessage(surface) {
  const message = surface.closest(".message.assistant") || surface;
  let sibling = message.previousElementSibling;
  while (sibling) {
    if (sibling.matches?.(".message.user")) return sibling;
    sibling = sibling.previousElementSibling;
  }
  return null;
}

export function createFailureRecoverySnapshotManager(options) {
  const store = createFailureRecoveryRequestStore(options);

  function snapshotForSurface(surface) {
    const snapshot = store.getSnapshot();
    if (!snapshot || snapshot.completedAt) return null;
    const user = nearestUserMessage(surface);
    if (!user) return snapshot;
    const signature = clean(user.textContent).slice(0, 180);
    if (!snapshot.promptSignature || signature.includes(snapshot.promptSignature) || snapshot.promptSignature.includes(signature)) return snapshot;
    return null;
  }

  function associateUserMessage(message) {
    const snapshot = store.getSnapshot();
    if (!(message instanceof HTMLElement) || !snapshot) return;
    const signature = clean(message.textContent).slice(0, 180);
    if (!snapshot.promptSignature || signature.includes(snapshot.promptSignature) || snapshot.promptSignature.includes(signature)) {
      message.dataset.failureRecoveryRequest = snapshot.id;
      snapshot.promptSignature = signature || snapshot.promptSignature;
      store.setActive(snapshot);
    }
  }

  function markCompleted(snapshot) {
    if (!snapshot || snapshot.completedAt) return;
    snapshot.completedAt = Date.now();
    store.setActive(snapshot);
  }

  function markRestored(snapshot, key) {
    if (!snapshot || !key || snapshot.restoredKeys?.includes(key)) return false;
    snapshot.restoredKeys = [...(snapshot.restoredKeys || []), key].slice(-12);
    store.setActive(snapshot);
    return true;
  }

  return {
    ...store,
    snapshotForSurface,
    associateUserMessage,
    markCompleted,
    markRestored,
  };
}
