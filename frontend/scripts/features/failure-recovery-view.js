/* SentIQ Liquid Glass V4 — Phase 7.5 recovery surfaces */

import { createFailureRecoveryPanel } from "./failure-recovery-panel.js";
import { createFailureRecoveryTray } from "./failure-recovery-tray.js";

export function createFailureRecoveryView(options) {
  const panel = createFailureRecoveryPanel(options);
  const tray = createFailureRecoveryTray(options);
  return {
    ensurePanel(surface, tool, state, snapshot) {
      tray.clear();
      return panel.ensure(surface, tool, state, snapshot);
    },
    ensureComposerTray: tray.ensure,
    hasRecoveryForSnapshot: panel.hasForSnapshot,
    clearTray: tray.clear,
  };
}
