/* SentIQ Chat — Pass 10.3 touch interaction language */

import {
  TOUCH_INTERACTION_VERSION,
  TOUCH_MENU_RELEASE_FRAMES,
  isEligibleTouchTarget,
  isTouchLikePointer,
  shouldCancelPressedFeedback,
} from "./touch-interaction-state.mjs";

const TOUCH_QUERY = "(hover: none), (pointer: coarse)";
const TARGET_SELECTOR = [
  "button",
  "summary",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  ".generated-file-action",
  ".asset-result-action",
  ".asset-result-retry",
  ".asset-overlay-action",
  ".websurf-v2-source-explorer-toggle",
  ".websurf-v2-featured-card",
  ".websurf-v2-explorer-source",
  ".deep-research-action-btn",
  ".deep-research-expand-btn",
].join(",");

const COMPACT_HITBOX_SELECTOR = [
  ".composer-mode-pill-dismiss",
  ".selected-context-remove",
  ".composer-attachment-remove",
  ".message-action-btn",
  ".websurf-v2-citation",
  ".websurf-v2-publisher-chip",
  ".citation-chip",
  ".citation-marker",
  ".source-citation",
].join(",");

const MENU_TRIGGER_SELECTOR = [
  "#composer-plus-btn",
  "#execution-mode-toggle",
  ".chat-actions-overflow-btn",
  "[aria-haspopup='menu']",
  "[aria-haspopup='listbox']",
  "[aria-controls='composer-action-menu']",
  "[aria-controls='execution-mode-menu']",
].join(",");

function initializeTouchInteractionLanguage() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQTouchInteraction?.version === TOUCH_INTERACTION_VERSION) return;

  const root = document.documentElement;
  const touchMedia = window.matchMedia?.(TOUCH_QUERY) || null;
  const subscribers = new Set();
  let activePress = null;
  let enhancementFrame = 0;
  let releaseFrame = 0;
  let touchMode = false;

  function isTouchMode() {
    return Boolean(touchMedia?.matches || Number(navigator.maxTouchPoints || 0) > 0);
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function markTarget(element) {
    if (!(element instanceof HTMLElement)) return;
    const eligible = isEligibleTouchTarget({
      connected: element.isConnected,
      visible: isVisible(element),
      disabled: "disabled" in element && Boolean(element.disabled),
      ariaDisabled: element.getAttribute("aria-disabled") === "true",
    });
    element.dataset.touchTarget = "true";
    element.dataset.touchTargetEligible = eligible ? "true" : "false";
    if (element.matches(COMPACT_HITBOX_SELECTOR)) {
      element.dataset.touchHitbox = "expanded";
    } else {
      element.dataset.touchHitbox = "minimum-box";
    }
  }

  function enhanceDragDiscoverability(scope = document) {
    const chrome = scope.querySelector?.(".mobile-navigation-sheet-chrome");
    if (!(chrome instanceof HTMLElement)) return;
    chrome.dataset.touchDragDiscoverable = "dismiss";
    chrome.setAttribute("aria-label", "Navigation sheet. Swipe down to close, or use the Close button.");
    const eyebrow = chrome.querySelector(".mobile-navigation-sheet-eyebrow");
    if (eyebrow instanceof HTMLElement && eyebrow.textContent !== "Swipe down to close") {
      eyebrow.textContent = "Swipe down to close";
    }
  }

  function enhance(scope = document) {
    if (!touchMode) return;
    if (scope instanceof Element && scope.matches(TARGET_SELECTOR)) markTarget(scope);
    scope.querySelectorAll?.(TARGET_SELECTOR).forEach(markTarget);
    if (scope instanceof Element && scope.matches(COMPACT_HITBOX_SELECTOR)) markTarget(scope);
    scope.querySelectorAll?.(COMPACT_HITBOX_SELECTOR).forEach(markTarget);
    enhanceDragDiscoverability(scope);
  }

  function scheduleEnhancement(scope = document) {
    window.cancelAnimationFrame(enhancementFrame);
    enhancementFrame = window.requestAnimationFrame(() => {
      enhancementFrame = 0;
      enhance(scope);
    });
  }

  function updateMode(reason = "mode") {
    touchMode = isTouchMode();
    root.dataset.touchInteractionVersion = TOUCH_INTERACTION_VERSION;
    root.dataset.touchInteractionMode = touchMode ? "touch" : "precision";
    document.body?.classList.toggle("touch-interaction-mode", touchMode);
    if (touchMode) scheduleEnhancement(document);
    else clearPress("precision-mode");
    notify(reason);
  }

  function findInteractiveTarget(eventTarget) {
    if (!(eventTarget instanceof Element)) return null;
    const element = eventTarget.closest(`${TARGET_SELECTOR},${COMPACT_HITBOX_SELECTOR}`);
    if (!(element instanceof HTMLElement)) return null;
    const eligible = isEligibleTouchTarget({
      connected: element.isConnected,
      visible: isVisible(element),
      disabled: "disabled" in element && Boolean(element.disabled),
      ariaDisabled: element.getAttribute("aria-disabled") === "true",
    });
    return eligible ? element : null;
  }

  function resolveControlledMenu(trigger) {
    if (!(trigger instanceof HTMLElement)) return null;
    const controlledId = String(trigger.getAttribute("aria-controls") || "").trim().split(/\s+/)[0];
    if (controlledId) {
      const controlled = document.getElementById(controlledId);
      if (controlled instanceof HTMLElement) return controlled;
    }
    if (trigger.id === "composer-plus-btn") return document.getElementById("composer-action-menu");
    if (trigger.id === "execution-mode-toggle") return document.getElementById("execution-mode-menu");
    const chatItem = trigger.closest(".chat-list-item");
    const chatMenu = chatItem?.querySelector(".chat-actions-menu");
    if (chatMenu instanceof HTMLElement) return chatMenu;
    const citationScope = trigger.closest(".websurf-v2-presentation, .message-content");
    const citationMenu = citationScope?.querySelector(".websurf-v2-citation-menu");
    return citationMenu instanceof HTMLElement ? citationMenu : null;
  }

  function holdMenuUntilRelease(trigger) {
    const menu = resolveControlledMenu(trigger);
    if (!(menu instanceof HTMLElement)) return;
    window.cancelAnimationFrame(releaseFrame);
    trigger.dataset.touchMenuTrigger = "true";
    menu.dataset.touchMenuUnderFinger = "true";
    activePress.menu = menu;
    activePress.menuTrigger = trigger;
  }

  function releaseMenuAfterFinger(menu, trigger) {
    if (!(menu instanceof HTMLElement)) return;
    let frames = Math.max(1, TOUCH_MENU_RELEASE_FRAMES);
    const release = () => {
      if (--frames > 0) {
        releaseFrame = window.requestAnimationFrame(release);
        return;
      }
      menu.removeAttribute("data-touch-menu-under-finger");
      trigger?.removeAttribute("data-touch-menu-trigger");
    };
    releaseFrame = window.requestAnimationFrame(release);
  }

  function clearPress(reason = "clear", options = {}) {
    if (!activePress) return;
    const current = activePress;
    activePress = null;
    current.element?.classList.remove("is-touch-pressed");
    current.element?.removeAttribute("data-touch-pressed");
    if (options.deferMenu !== false) releaseMenuAfterFinger(current.menu, current.menuTrigger);
    else {
      current.menu?.removeAttribute("data-touch-menu-under-finger");
      current.menuTrigger?.removeAttribute("data-touch-menu-trigger");
    }
    notify(reason);
  }

  function handlePointerDown(event) {
    if (!touchMode || event.button > 0 || !isTouchLikePointer(event.pointerType, !event.pointerType && touchMode)) return;
    const element = findInteractiveTarget(event.target);
    if (!element) return;
    clearPress("replace", { deferMenu: false });
    activePress = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      element,
      menu: null,
      menuTrigger: null,
    };
    element.classList.add("is-touch-pressed");
    element.dataset.touchPressed = "true";
    const menuTrigger = element.closest(MENU_TRIGGER_SELECTOR);
    if (menuTrigger instanceof HTMLElement) holdMenuUntilRelease(menuTrigger);
    notify("pointer-down");
  }

  function handlePointerMove(event) {
    if (!activePress || event.pointerId !== activePress.pointerId) return;
    if (shouldCancelPressedFeedback({
      startX: activePress.startX,
      startY: activePress.startY,
      currentX: event.clientX,
      currentY: event.clientY,
    })) clearPress("pointer-drag", { deferMenu: false });
  }

  function handlePointerUp(event) {
    if (!activePress || event.pointerId !== activePress.pointerId) return;
    clearPress("pointer-up");
  }

  function handlePointerCancel(event) {
    if (!activePress || event.pointerId !== activePress.pointerId) return;
    clearPress("pointer-cancel", { deferMenu: false });
  }

  function notify(reason) {
    const detail = Object.freeze({
      version: TOUCH_INTERACTION_VERSION,
      reason,
      touchMode,
      pressed: Boolean(activePress),
    });
    subscribers.forEach((listener) => {
      try { listener(detail); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-touch-interaction-change", { detail }));
  }

  document.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: true });
  document.addEventListener("pointermove", handlePointerMove, { capture: true, passive: true });
  document.addEventListener("pointerup", handlePointerUp, { capture: true, passive: true });
  document.addEventListener("pointercancel", handlePointerCancel, { capture: true, passive: true });
  window.addEventListener("blur", () => clearPress("window-blur", { deferMenu: false }));
  window.addEventListener("scroll", () => clearPress("window-scroll", { deferMenu: false }), { capture: true, passive: true });
  touchMedia?.addEventListener?.("change", () => updateMode("media-change"));

  new MutationObserver((records) => {
    if (!touchMode) return;
    const relevant = records.some((record) => (
      record.type === "attributes" || record.addedNodes.length > 0
    ));
    if (relevant) scheduleEnhancement(document);
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "aria-disabled", "disabled"],
  });

  window.SentIQTouchInteraction = Object.freeze({
    version: TOUCH_INTERACTION_VERSION,
    isTouchMode: () => touchMode,
    refresh: () => updateMode("manual"),
    enhance: (scope = document) => enhance(scope),
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false) listener(Object.freeze({
        version: TOUCH_INTERACTION_VERSION,
        reason: "subscribe",
        touchMode,
        pressed: Boolean(activePress),
      }));
      return () => subscribers.delete(listener);
    },
  });

  updateMode("initial");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeTouchInteractionLanguage, { once: true });
} else {
  initializeTouchInteractionLanguage();
}
