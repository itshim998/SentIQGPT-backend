/* SentIQ Chat — Phase 12.1 accessibility verification runtime */

import {
  ACCESSIBILITY_MIN_TOUCH_TARGET,
  ACCESSIBILITY_VERIFICATION_VERSION,
  isRovingNavigationKey,
  nextRovingIndex,
} from "./accessibility-verification-state.mjs";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const MENU_ITEM_SELECTOR = [
  "[role='menuitem']",
  "[role='option']",
  "button:not([disabled])",
  "a[href]",
].join(",");

const KNOWN_LABELS = Object.freeze({
  "chat-search-input": "Search conversations",
  "composer-plus-btn": "More message actions",
  "execution-mode-toggle": "Choose execution mode",
  "send-btn": "Send message",
  "sidebar-toggle": "Open navigation",
  "sidebar-collapse-btn": "Collapse chat history",
  "scroll-anchor-pill": "Jump to latest message",
});

function isElementVisible(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden) return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  if ("disabled" in element && element.disabled) return false;
  try {
    const style = window.getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && element.getClientRects().length > 0;
  } catch {
    return true;
  }
}

function visibleFocusable(scope) {
  if (!(scope instanceof Element)) return [];
  return Array.from(scope.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isElementVisible);
}

function textAlternative(element) {
  if (!(element instanceof Element)) return "";
  const labelledBy = String(element.getAttribute("aria-labelledby") || "").trim();
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() || "")
      .filter(Boolean)
      .join(" ");
    if (label) return label;
  }
  const direct = String(element.getAttribute("aria-label") || "").trim();
  if (direct) return direct;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const label = element.labels?.[0]?.textContent?.trim();
    if (label) return label;
    const placeholder = String(element.getAttribute("placeholder") || "").trim();
    if (placeholder) return placeholder;
  }
  return String(element.textContent || "").replace(/\s+/g, " ").trim();
}

function ensureKnownLabels(scope = document) {
  Object.entries(KNOWN_LABELS).forEach(([id, label]) => {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLElement)) return;
    if (!textAlternative(element)) element.setAttribute("aria-label", label);
  });

  scope.querySelectorAll?.("button[title], a[title], [role='button'][title]").forEach((element) => {
    if (!textAlternative(element)) element.setAttribute("aria-label", element.getAttribute("title"));
  });

  scope.querySelectorAll?.("button svg, a svg, [role='button'] svg").forEach((icon) => {
    if (icon.hasAttribute("role") || icon.querySelector("title")) return;
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
  });
}

function ensureDocumentLandmarks() {
  const body = document.body;
  const main = document.querySelector("main.main-content, main");
  if (!(body instanceof HTMLElement) || !(main instanceof HTMLElement)) return;

  if (!main.id) main.id = "main-content";
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;

  let skipLink = document.getElementById("sentiq-skip-link");
  if (!(skipLink instanceof HTMLAnchorElement)) {
    skipLink = document.createElement("a");
    skipLink.id = "sentiq-skip-link";
    skipLink.className = "sentiq-skip-link";
    skipLink.href = `#${main.id}`;
    skipLink.textContent = "Skip to main content";
    body.prepend(skipLink);
  }

  skipLink.addEventListener("click", () => {
    window.requestAnimationFrame(() => main.focus({ preventScroll: true }));
  });
}

function ensureStaticSemantics(scope = document) {
  const chatMessages = document.getElementById("chat-messages");
  if (chatMessages instanceof HTMLElement) {
    chatMessages.setAttribute("role", "log");
    chatMessages.setAttribute("aria-label", "Conversation messages");
    chatMessages.setAttribute("aria-live", "polite");
    chatMessages.setAttribute("aria-relevant", "additions text");
    chatMessages.setAttribute("aria-atomic", "false");
    if (!chatMessages.hasAttribute("tabindex")) chatMessages.tabIndex = 0;
  }

  const starterActions = document.getElementById("starter-actions");
  if (starterActions instanceof HTMLElement && !starterActions.hasAttribute("role")) {
    starterActions.setAttribute("role", "group");
  }

  const composerMenu = document.getElementById("composer-action-menu");
  if (composerMenu instanceof HTMLElement) {
    composerMenu.setAttribute("role", "menu");
    composerMenu.setAttribute("aria-label", "Message actions");
    composerMenu.querySelectorAll(".composer-action-option").forEach((item) => item.setAttribute("role", "menuitem"));
  }

  const composerTrigger = document.getElementById("composer-plus-btn");
  if (composerTrigger instanceof HTMLElement) {
    composerTrigger.setAttribute("aria-haspopup", "menu");
    composerTrigger.setAttribute("aria-controls", "composer-action-menu");
  }

  const executionToggle = document.getElementById("execution-mode-toggle");
  if (executionToggle instanceof HTMLElement) {
    executionToggle.setAttribute("aria-haspopup", "listbox");
    const current = document.getElementById("execution-mode-label")?.textContent?.trim();
    executionToggle.setAttribute("aria-label", current ? `Choose execution mode. Current mode: ${current}` : "Choose execution mode");
  }

  scope.querySelectorAll?.("[role='dialog'][aria-modal='true']").forEach((dialog) => {
    if (!(dialog instanceof HTMLElement)) return;
    if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
    const labelledBy = dialog.getAttribute("aria-labelledby");
    if (labelledBy && document.getElementById(labelledBy)) return;
    const heading = dialog.querySelector("h1, h2, h3, [data-adaptive-panel-title]");
    if (!(heading instanceof HTMLElement)) return;
    if (!heading.id) heading.id = `sentiq-dialog-title-${Math.random().toString(36).slice(2, 9)}`;
    dialog.setAttribute("aria-labelledby", heading.id);
  });

  scope.querySelectorAll?.("[role='tablist']").forEach((tabList) => {
    if (!(tabList instanceof HTMLElement)) return;
    tabList.querySelectorAll("[role='tab']").forEach((tab, index) => {
      if (!(tab instanceof HTMLElement)) return;
      if (!tab.hasAttribute("tabindex")) tab.tabIndex = tab.getAttribute("aria-selected") === "true" || index === 0 ? 0 : -1;
    });
  });

  scope.querySelectorAll?.("[tabindex]").forEach((element) => {
    if (element instanceof HTMLElement && element.tabIndex > 0) element.tabIndex = 0;
  });
}

function ensureLiveSemantics(scope = document) {
  scope.querySelectorAll?.(".response-inline-loader, .semantic-surface-progress, .semantic-legacy-progress").forEach((status) => {
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
  });

  scope.querySelectorAll?.(".sentiq-loader-host").forEach((host) => {
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-busy", "true");
    if (!textAlternative(host)) host.setAttribute("aria-label", "Working");
  });

  scope.querySelectorAll?.(".failure-recovery-panel, .chat-load-error").forEach((alert) => {
    alert.setAttribute("role", "alert");
    alert.setAttribute("aria-live", "assertive");
    alert.setAttribute("aria-atomic", "true");
  });

  scope.querySelectorAll?.("[data-asset-result-version].is-loading, .image-generation-card.is-loading, .deep-research-card[aria-busy='true']")
    .forEach((busy) => busy.setAttribute("aria-busy", "true"));
}

function ensureTouchMetadata(scope = document) {
  scope.querySelectorAll?.("button, [role='button'], [role='menuitem'], [role='option'], summary").forEach((control) => {
    if (!(control instanceof HTMLElement)) return;
    control.style.setProperty("--sentiq-a11y-touch-target", `${ACCESSIBILITY_MIN_TOUCH_TARGET}px`);
  });
}

function enhance(scope = document) {
  ensureKnownLabels(scope);
  ensureStaticSemantics(scope);
  ensureLiveSemantics(scope);
  ensureTouchMetadata(scope);
}

function menuItems(container) {
  if (!(container instanceof HTMLElement)) return [];
  return Array.from(container.querySelectorAll(MENU_ITEM_SELECTOR)).filter((item) => {
    if (!(item instanceof HTMLElement) || !isElementVisible(item)) return false;
    if (container.getAttribute("role") === "menu") return item.getAttribute("role") === "menuitem" || item.matches("button, a[href]");
    if (container.getAttribute("role") === "listbox") return item.getAttribute("role") === "option";
    return true;
  });
}

function controlledContainer(trigger) {
  if (!(trigger instanceof HTMLElement)) return null;
  const ids = String(trigger.getAttribute("aria-controls") || "").trim().split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const controlled = document.getElementById(id);
    if (controlled instanceof HTMLElement && ["menu", "listbox"].includes(controlled.getAttribute("role"))) return controlled;
  }
  return null;
}

function triggerFor(container) {
  if (!(container instanceof HTMLElement) || !container.id) return null;
  return document.querySelector(`[aria-controls~="${CSS.escape(container.id)}"]`);
}

function focusMenuEdge(trigger, edge = "first") {
  const container = controlledContainer(trigger);
  if (!(container instanceof HTMLElement)) return false;
  if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
  window.requestAnimationFrame(() => {
    const items = menuItems(container);
    const target = edge === "last" ? items[items.length - 1] : items[0];
    target?.focus?.({ preventScroll: true });
  });
  return true;
}

function closeControlledContainer(container, restoreFocus = true) {
  const trigger = triggerFor(container);
  if (!(trigger instanceof HTMLElement)) return false;
  if (trigger.getAttribute("aria-expanded") === "true") trigger.click();
  if (restoreFocus) window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
  return true;
}

function handleRovingContainerKey(event, container) {
  const items = menuItems(container);
  if (!items.length || !isRovingNavigationKey(event.key)) return false;
  const orientation = container.getAttribute("aria-orientation") || (container.getAttribute("role") === "menu" ? "vertical" : "both");
  const currentIndex = Math.max(0, items.indexOf(document.activeElement));
  const nextIndex = nextRovingIndex({ currentIndex, itemCount: items.length, key: event.key, orientation });
  if (nextIndex === currentIndex && !["Home", "End"].includes(event.key)) return false;
  event.preventDefault();
  event.stopPropagation();
  items[nextIndex]?.focus?.({ preventScroll: true });
  return true;
}

function handleTabListKey(event, tabList) {
  if (!isRovingNavigationKey(event.key)) return false;
  const tabs = Array.from(tabList.querySelectorAll("[role='tab']")).filter(isElementVisible);
  if (!tabs.length) return false;
  const orientation = tabList.getAttribute("aria-orientation") || "horizontal";
  const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
  const nextIndex = nextRovingIndex({ currentIndex, itemCount: tabs.length, key: event.key, orientation });
  if (nextIndex === currentIndex && !["Home", "End"].includes(event.key)) return false;
  event.preventDefault();
  event.stopPropagation();
  const target = tabs[nextIndex];
  target?.focus?.({ preventScroll: true });
  target?.click?.();
  return true;
}

function activeModalDialog() {
  const dialogs = Array.from(document.querySelectorAll("[role='dialog'][aria-modal='true']")).filter(isElementVisible);
  if (!dialogs.length) return null;
  return dialogs
    .map((dialog, index) => ({
      dialog,
      index,
      zIndex: Number.parseInt(window.getComputedStyle(dialog.closest(".adaptive-panel-root, .modal-overlay, .live-beta-panel") || dialog).zIndex, 10) || 0,
    }))
    .sort((first, second) => first.zIndex - second.zIndex || first.index - second.index)
    .at(-1)?.dialog || null;
}

function focusDialog(dialog) {
  if (!(dialog instanceof HTMLElement)) return;
  const target = dialog.querySelector("[autofocus], [data-panel-initial-focus]") || visibleFocusable(dialog)[0] || dialog;
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

function ensureAnnouncer() {
  let announcer = document.getElementById("sentiq-a11y-announcer");
  if (announcer instanceof HTMLElement) return announcer;
  announcer = document.createElement("div");
  announcer.id = "sentiq-a11y-announcer";
  announcer.className = "sentiq-a11y-announcer sr-only";
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");
  announcer.setAttribute("aria-atomic", "true");
  document.body.appendChild(announcer);
  return announcer;
}

function initializeAccessibilityVerification() {
  if (typeof document === "undefined" || !document.body) return;
  if (window.SentIQAccessibility?.version === ACCESSIBILITY_VERIFICATION_VERSION) return;

  const root = document.documentElement;
  const announcer = ensureAnnouncer();
  const pendingScopes = new Set();
  let enhancementFrame = 0;
  let announcementTimer = 0;

  root.dataset.accessibilityVerificationVersion = ACCESSIBILITY_VERIFICATION_VERSION;
  ensureDocumentLandmarks();
  enhance(document);

  function announce(message, priority = "polite") {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    window.clearTimeout(announcementTimer);
    announcer.setAttribute("aria-live", priority === "assertive" ? "assertive" : "polite");
    announcer.textContent = "";
    announcementTimer = window.setTimeout(() => { announcer.textContent = text; }, 20);
  }

  function scheduleEnhance(scope) {
    if (scope instanceof Element || scope === document) pendingScopes.add(scope);
    if (enhancementFrame) return;
    enhancementFrame = window.requestAnimationFrame(() => {
      enhancementFrame = 0;
      const scopes = Array.from(pendingScopes);
      pendingScopes.clear();
      scopes.forEach(enhance);
    });
  }

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const trigger = target.closest("[aria-controls][aria-haspopup='menu'], [aria-controls][aria-haspopup='listbox']");
    if (trigger instanceof HTMLElement && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      focusMenuEdge(trigger, event.key === "ArrowUp" ? "last" : "first");
      return;
    }

    const container = target.closest("[role='menu'], [role='listbox']");
    if (container instanceof HTMLElement) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeControlledContainer(container, true);
        return;
      }
      if (handleRovingContainerKey(event, container)) return;
    }

    const tabList = target.closest("[role='tablist']");
    if (tabList instanceof HTMLElement) handleTabListKey(event, tabList);
  }, true);

  document.addEventListener("focusin", (event) => {
    const dialog = activeModalDialog();
    if (!(dialog instanceof HTMLElement) || dialog.contains(event.target)) return;
    event.stopPropagation();
    window.requestAnimationFrame(() => focusDialog(dialog));
  }, true);

  document.addEventListener("sentiq-mobile-navigation-change", (event) => {
    if (event?.detail?.reason === "mutation") return;
    announce(event?.detail?.open ? "Navigation opened" : "Navigation closed");
  });

  document.addEventListener("sentiq-panel-stack-restored", () => announce("Returned to the conversation"));

  new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === "attributes" && record.target instanceof Element) scheduleEnhance(record.target);
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) scheduleEnhance(node);
      });
    });
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "aria-expanded", "aria-selected", "aria-busy", "role", "title"],
  });

  window.SentIQAccessibility = Object.freeze({
    version: ACCESSIBILITY_VERIFICATION_VERSION,
    announce,
    enhance,
    getActiveModal: () => activeModalDialog()?.id || null,
    audit() {
      const unnamed = Array.from(document.querySelectorAll("button, a[href], input, textarea, select"))
        .filter(isElementVisible)
        .filter((element) => !textAlternative(element));
      const positiveTabIndex = Array.from(document.querySelectorAll("[tabindex]"))
        .filter((element) => element instanceof HTMLElement && element.tabIndex > 0);
      return Object.freeze({ unnamed: unnamed.length, positiveTabIndex: positiveTabIndex.length });
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAccessibilityVerification, { once: true });
} else {
  initializeAccessibilityVerification();
}
