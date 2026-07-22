/* SentIQ Liquid Glass V4 — Pass 8.4 panel lifecycle recovery */

const PANEL_LIFECYCLE_VERSION = "8.4";
const PANEL_FOCUSABLE_SELECTOR = [
  "[data-panel-initial-focus]",
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isElementVisible(element) {
  if (!(element instanceof HTMLElement) || element.hidden) return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  try {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  } catch {
    return true;
  }
}

function isPanelVisible(root) {
  if (!(root instanceof HTMLElement) || root.hidden || root.getAttribute("aria-hidden") === "true") return false;
  if (root.id === "account-panel" && !root.classList.contains("visible")) return false;
  try {
    const style = window.getComputedStyle(root);
    return style.display !== "none" && style.visibility !== "hidden";
  } catch {
    return root.style.display !== "none";
  }
}

function firstPanelFocusTarget(root) {
  if (!(root instanceof HTMLElement)) return null;
  const surface = root.querySelector(".adaptive-panel-surface") || root;
  const preferred = surface.querySelector("[data-panel-initial-focus]");
  if (isElementVisible(preferred)) return preferred;
  return Array.from(surface.querySelectorAll(PANEL_FOCUSABLE_SELECTOR)).find(isElementVisible)
    || (surface instanceof HTMLElement ? surface : null);
}

function focusSafely(target) {
  if (!isElementVisible(target) || target.matches?.(":disabled")) return false;
  try {
    target.focus({ preventScroll: true });
    return document.activeElement === target || target.contains?.(document.activeElement);
  } catch {
    return false;
  }
}

function initializePanelFocusRecovery() {
  if (typeof document === "undefined" || !document.body) return;
  if (document.documentElement.dataset.panelLifecycleVersion === PANEL_LIFECYCLE_VERSION) return;
  document.documentElement.dataset.panelLifecycleVersion = PANEL_LIFECYCLE_VERSION;

  const triggerByPanel = new WeakMap();
  let restoreFrame = 0;

  function resolvePanelRoot(event) {
    const target = event?.target;
    if (!(target instanceof HTMLElement)) return null;
    return target.classList.contains("adaptive-panel-root")
      ? target
      : target.closest(".adaptive-panel-root");
  }

  function syncPanelStack() {
    window.SentIQPanels?.sync?.();
    const anyPanelOpen = Array.from(document.querySelectorAll(".adaptive-panel-root")).some(isPanelVisible);
    if (!anyPanelOpen) {
      document.body.classList.remove("adaptive-panel-open", "adaptive-panel-modal-open");
    }
    return anyPanelOpen;
  }

  document.addEventListener("sentiq-panel-opened", (event) => {
    const root = resolvePanelRoot(event);
    if (!root) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isConnected && !root.contains(active)) {
      triggerByPanel.set(root, active);
    }
  });

  document.addEventListener("sentiq-panel-closed", (event) => {
    const root = resolvePanelRoot(event);
    if (!root) return;
    const previousTrigger = triggerByPanel.get(root) || null;
    triggerByPanel.delete(root);

    window.cancelAnimationFrame(restoreFrame);
    restoreFrame = window.requestAnimationFrame(() => {
      restoreFrame = 0;
      syncPanelStack();

      const activePanelId = window.SentIQPanels?.getActive?.();
      const activeRoot = activePanelId ? document.getElementById(activePanelId) : null;
      if (isPanelVisible(activeRoot)) {
        if (!activeRoot.contains(document.activeElement)) focusSafely(firstPanelFocusTarget(activeRoot));
        return;
      }

      if (!focusSafely(previousTrigger)) {
        const fallback = document.querySelector("#chat-input:not([disabled]), #new-chat-btn:not([disabled]), #sidebar-toggle:not([disabled])");
        focusSafely(fallback);
      }

      document.dispatchEvent(new CustomEvent("sentiq-panel-stack-restored", {
        detail: { closedPanelId: root.id || "unknown" },
      }));
    });
  });

  window.addEventListener("pageshow", () => {
    window.requestAnimationFrame(syncPanelStack);
  }, { passive: true });

  window.SentIQPanelLifecycle = Object.freeze({
    version: PANEL_LIFECYCLE_VERSION,
    sync: syncPanelStack,
  });
}

initializePanelFocusRecovery();
