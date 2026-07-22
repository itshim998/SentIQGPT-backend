/* SentIQ Liquid Glass V4 — Phase 8.1 adaptive panel framework */

import {
  ADAPTIVE_PANEL_CONFIGS,
  ADAPTIVE_PANEL_VERSION,
  isAdaptivePanelModal,
  resolveAdaptivePanelMode,
} from "./adaptive-panel-state.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function initializeAdaptivePanels() {
  if (typeof document === "undefined" || !document.body) return;

  const entries = [];
  const entryByRoot = new Map();
  const inerted = new Map();
  let sequence = 0;
  let resizeFrame = 0;

  function isVisible(root) {
    if (!(root instanceof HTMLElement)) return false;
    if (root.hidden || root.getAttribute("aria-hidden") === "true") return false;
    if (root.id === "account-panel" && !root.classList.contains("visible")) return false;
    try {
      const style = window.getComputedStyle(root);
      return style.display !== "none" && style.visibility !== "hidden";
    } catch {
      return root.style.display !== "none";
    }
  }

  function visibleFocusable(surface) {
    return Array.from(surface.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
      if (!(element instanceof HTMLElement) || element.hidden || element.closest("[hidden], [inert]")) return false;
      if (element.getAttribute("aria-hidden") === "true") return false;
      try {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      } catch {
        return true;
      }
    });
  }

  function generatedCloseButton(entry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "adaptive-panel-close adaptive-panel-generated-close";
    button.dataset.adaptivePanelGeneratedClose = "true";
    button.setAttribute("aria-label", `Close ${entry.config.titleLabel || "panel"}`);
    button.title = "Close";
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="M6 6l12 12"></path></svg>';
    button.addEventListener("click", () => requestClose(entry, "close-button"));
    return button;
  }

  function ensureTitle(entry, header) {
    let title = entry.config.titleSelector
      ? entry.root.querySelector(entry.config.titleSelector)
      : null;
    if (!title && entry.config.titleLabel && header) {
      title = document.createElement("span");
      title.className = "adaptive-panel-title adaptive-panel-title-sr";
      title.textContent = entry.config.titleLabel;
      header.prepend(title);
    }
    if (!(title instanceof HTMLElement)) return null;
    title.classList.add("adaptive-panel-title");
    if (!title.id) title.id = `adaptive-panel-title-${entry.config.id}`;
    entry.surface.setAttribute("aria-labelledby", title.id);
    return title;
  }

  function decorate(entry) {
    const { root, surface, config } = entry;
    root.classList.add("adaptive-panel-root");
    root.dataset.adaptivePanelVersion = ADAPTIVE_PANEL_VERSION;
    root.dataset.adaptivePanelId = config.id;
    root.dataset.adaptivePanelPlacement = config.desktopPlacement || "center";
    root.dataset.adaptivePanelMobile = config.mobileMode || "bottom";
    surface.classList.add("adaptive-panel-surface");
    surface.dataset.adaptivePanelSurface = config.id;
    if (!surface.hasAttribute("tabindex")) surface.tabIndex = -1;

    const header = config.headerSelector ? root.querySelector(config.headerSelector) : null;
    if (header instanceof HTMLElement) {
      header.classList.add("adaptive-panel-header");
      ensureTitle(entry, header);
      const existingClose = config.existingCloseSelector
        ? root.querySelector(config.existingCloseSelector)
        : null;
      if (existingClose instanceof HTMLElement) {
        existingClose.classList.add("adaptive-panel-close");
        existingClose.dataset.adaptivePanelClose = config.id;
      } else if (config.generatedClose && config.dismissible !== false) {
        header.appendChild(generatedCloseButton(entry));
      }
    }
  }

  function restoreBackground() {
    inerted.forEach((previous, element) => {
      if (!(element instanceof HTMLElement)) return;
      element.inert = previous.inert;
      if (previous.hadInertAttribute) element.setAttribute("inert", "");
      else element.removeAttribute("inert");
      if (previous.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", previous.ariaHidden);
    });
    inerted.clear();
  }

  function shouldSkipBackgroundNode(element) {
    return !(element instanceof HTMLElement)
      || ["SCRIPT", "STYLE", "LINK"].includes(element.tagName)
      || element.id === "toast-container";
  }

  function makeInert(element) {
    if (shouldSkipBackgroundNode(element) || inerted.has(element)) return;
    inerted.set(element, {
      inert: Boolean(element.inert),
      hadInertAttribute: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    });
    element.inert = true;
    element.setAttribute("inert", "");
    element.setAttribute("aria-hidden", "true");
  }

  function inertAround(activeRoot) {
    restoreBackground();
    let activeBranch = activeRoot;
    while (activeBranch?.parentElement) {
      const parent = activeBranch.parentElement;
      Array.from(parent.children).forEach((sibling) => {
        if (sibling !== activeBranch) makeInert(sibling);
      });
      activeBranch = parent;
      if (parent === document.body) break;
    }
  }

  function openEntries() {
    return entries.filter((entry) => entry.open).sort((a, b) => a.sequence - b.sequence);
  }

  function activeEntry(modalOnly = false) {
    const candidates = openEntries().filter((entry) => !modalOnly || entry.modal);
    return candidates[candidates.length - 1] || null;
  }

  function updateBackgroundState() {
    const activeModal = activeEntry(true);
    document.body.classList.toggle("adaptive-panel-modal-open", Boolean(activeModal));
    document.body.classList.toggle("adaptive-panel-open", openEntries().length > 0);
    if (activeModal) inertAround(activeModal.root);
    else restoreBackground();
  }

  function applyMode(entry) {
    const mode = resolveAdaptivePanelMode(entry.config, window.innerWidth);
    const modal = isAdaptivePanelModal(entry.config, mode);
    entry.mode = mode;
    entry.modal = modal;
    entry.root.dataset.adaptivePanelMode = mode;
    entry.root.dataset.adaptivePanelModal = String(modal);
    entry.surface.dataset.adaptivePanelMode = mode;
    if (modal) {
      entry.surface.setAttribute("role", "dialog");
      entry.surface.setAttribute("aria-modal", "true");
    } else {
      if (entry.originalRole === null) entry.surface.removeAttribute("role");
      else entry.surface.setAttribute("role", entry.originalRole);
      if (entry.originalAriaModal === null) entry.surface.removeAttribute("aria-modal");
      else entry.surface.setAttribute("aria-modal", entry.originalAriaModal);
    }
  }

  function focusEntry(entry) {
    window.requestAnimationFrame(() => {
      if (!entry.open || !entry.modal || entry.surface.contains(document.activeElement)) return;
      const preferred = entry.surface.querySelector("[autofocus], [data-panel-initial-focus]");
      const target = preferred instanceof HTMLElement
        ? preferred
        : visibleFocusable(entry.surface)[0] || entry.surface;
      target.focus({ preventScroll: true });
    });
  }

  function dispatchPanelEvent(entry, name, detail = {}) {
    entry.root.dispatchEvent(new CustomEvent(name, {
      bubbles: true,
      detail: { panelId: entry.config.id, mode: entry.mode, ...detail },
    }));
  }

  function syncEntry(entry) {
    applyMode(entry);
    const visible = isVisible(entry.root);
    if (visible === entry.open) {
      if (visible) updateBackgroundState();
      return;
    }

    entry.open = visible;
    entry.root.dataset.adaptivePanelOpen = String(visible);
    if (visible) {
      entry.sequence = ++sequence;
      entry.root.style.setProperty("--adaptive-panel-stack", String(entry.sequence));
      entry.previousFocus = document.activeElement instanceof HTMLElement && !entry.root.contains(document.activeElement)
        ? document.activeElement
        : null;
      dispatchPanelEvent(entry, "sentiq-panel-opened");
      updateBackgroundState();
      focusEntry(entry);
    } else {
      dispatchPanelEvent(entry, "sentiq-panel-closed");
      updateBackgroundState();
      const restoreTarget = entry.previousFocus;
      entry.previousFocus = null;
      window.requestAnimationFrame(() => {
        if (!activeEntry(true) && restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
      });
    }
  }

  function requestClose(entry, reason = "dismiss") {
    if (!entry?.open || entry.config.dismissible === false) {
      entry?.surface?.focus?.({ preventScroll: true });
      return false;
    }
    const allowed = entry.root.dispatchEvent(new CustomEvent("sentiq-panel-before-close", {
      bubbles: true,
      cancelable: true,
      detail: { panelId: entry.config.id, reason },
    }));
    if (!allowed) return false;
    const action = entry.config.closeActionSelector
      ? document.querySelector(entry.config.closeActionSelector)
      : null;
    if (action instanceof HTMLElement) {
      action.click();
      return true;
    }
    return false;
  }

  function handleKeydown(event) {
    const entry = activeEntry(false);
    if (!entry) return;
    if (event.key === "Escape") {
      if (entry.config.dismissible === false) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose(entry, "escape");
      return;
    }
    if (event.key !== "Tab" || !entry.modal) return;
    const focusable = visibleFocusable(entry.surface);
    if (focusable.length === 0) {
      event.preventDefault();
      entry.surface.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!entry.surface.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      event.stopImmediatePropagation();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      event.stopImmediatePropagation();
      first.focus({ preventScroll: true });
    }
  }

  function register(config) {
    const root = document.getElementById(config.id);
    if (!(root instanceof HTMLElement) || entryByRoot.has(root)) return null;
    const surface = config.surfaceSelector ? root.querySelector(config.surfaceSelector) : root;
    if (!(surface instanceof HTMLElement)) return null;
    const entry = {
      config,
      root,
      surface,
      open: false,
      modal: false,
      mode: "",
      sequence: 0,
      previousFocus: null,
      originalRole: surface.getAttribute("role"),
      originalAriaModal: surface.getAttribute("aria-modal"),
    };
    entries.push(entry);
    entryByRoot.set(root, entry);
    decorate(entry);
    syncEntry(entry);
    return entry;
  }

  ADAPTIVE_PANEL_CONFIGS.forEach(register);

  const observer = new MutationObserver((records) => {
    const changed = new Set();
    records.forEach((record) => {
      const entry = entryByRoot.get(record.target);
      if (entry) changed.add(entry);
    });
    changed.forEach(syncEntry);
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "hidden", "aria-hidden", "class"],
  });

  document.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      entries.forEach(applyMode);
      updateBackgroundState();
      const topModal = activeEntry(true);
      if (topModal) focusEntry(topModal);
    });
  }, { passive: true });

  window.SentIQPanels = Object.freeze({
    version: ADAPTIVE_PANEL_VERSION,
    register,
    sync: () => entries.forEach(syncEntry),
    getActive: () => activeEntry(false)?.config.id || null,
    isOpen: (id) => Boolean(entries.find((entry) => entry.config.id === id)?.open),
    requestClose: (id, reason) => requestClose(entries.find((entry) => entry.config.id === id), reason),
  });
}

initializeAdaptivePanels();
