/* SentIQ Liquid Glass V4 — Phase 7.5 failure recovery */

import { startFailureRecoveryLifecycle } from "./failure-recovery-lifecycle.js";
import { createFailureRecoverySnapshotManager } from "./failure-recovery-snapshot.js";
import { createFailureRecoverySurfaceEnhancer } from "./failure-recovery-surface.js";
import { createFailureRecoveryView } from "./failure-recovery-view.js";

function initFailureRecovery() {
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const filePreview = document.getElementById("file-preview-area");
  const toastContainer = document.getElementById("toast-container");
  const chatInputWrapper = chatInput?.closest(".chat-input-wrapper");
  if (!(chatMessages instanceof HTMLElement) || !(chatInput instanceof HTMLTextAreaElement)) return;

  const snapshots = createFailureRecoverySnapshotManager({
    chatMessages,
    chatInput,
    filePreview,
    chatInputWrapper,
    modeControls: {
      image: document.getElementById("image-gen-btn"),
      websurf: document.getElementById("websurf-basic-btn"),
      "deep-research": document.getElementById("deep-research-btn"),
    },
  });
  const view = createFailureRecoveryView({
    chatMessages,
    chatInput,
    chatInputWrapper,
    snapshotManager: snapshots,
  });

  startFailureRecoveryLifecycle({
    chatMessages,
    chatInput,
    toastContainer,
    snapshots,
    view,
    enhanceSurface: createFailureRecoverySurfaceEnhancer(snapshots, view),
  });
}

if (typeof document !== "undefined") initFailureRecovery();
