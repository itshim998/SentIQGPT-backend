/* SentIQ Chat — Phase 10.1 dedicated mobile navigation sheet */

import {
  MOBILE_NAVIGATION_VERSION,
  clampMobileNavigationDrag,
  deriveMobileNavigationState,
  isMobileNavigationViewport,
  shouldCloseMobileNavigationGesture,
} from "./mobile-navigation-state.mjs";

const MOBILE_QUERY = "(max-width: 768px)";
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function initializeMobileNavigation() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQMobileNavigation?.version === MOBILE_NAVIGATION_VERSION) return;

  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const appContainer = document.querySelector(".app-container");
  const mainContent = document.querySelector(".main-content");
  const chatMessages = document.getElementById("chat-messages");
  if (!(sidebar instanceof HTMLElement) || !(sidebarToggle instanceof HTMLElement) || !(appContainer instanceof HTMLElement)) return;

  const media = window.matchMedia?.(MOBILE_QUERY) || null;
  const originalSidebarAttributes = {
    role: sidebar.getAttribute("role"),
    ariaModal: sidebar.getAttribute("aria-modal"),
    ariaLabel: sidebar.getAttribute("aria-label"),
    ariaLabelledby: sidebar.getAttribute("aria-labelledby"),
    ariaHidden: sidebar.getAttribute("aria-hidden"),
    tabIndex: sidebar.getAttribute("tabindex"),
    inert: sidebar.hasAttribute("inert"),
  };
  const inertSnapshots = new Map();
  const boundBackdrops = new WeakSet();
  const subscribers = new Set();
  const defer = typeof window.queueMicrotask === "function"
    ? window.queueMicrotask.bind(window)
    : (callback) => Promise.resolve().then(callback);

  let lastOpen = false;
  let lastMobile = false;
  let restoreFocusOnClose = false;
  let scrollSnapshot = null;
  let backdrop = null;
  let viewportFrame = 0;
  let focusFrame = 0;
  let gesture = null;

  function isMobile() {
    if (media) return media.matches;
    return isMobileNavigationViewport(window.innerWidth);
  }

  function isOpen() {
    return isMobile() && sidebar.classList.contains("open");
  }

  function setAttr(element, name, value) {
    if (!(element instanceof Element)) return;
    if (value === null || value === undefined || value === "") {
      if (element.hasAttribute(name)) element.removeAttribute(name);
      return;
    }
    const next = String(value);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }

  function setClassIfChanged(element, className, enabled) {
    if (!(element instanceof Element)) return;
    const next = Boolean(enabled);
    if (element.classList.contains(className) !== next) element.classList.toggle(className, next);
  }

  function ensureSheetChrome() {
    let chrome = sidebar.querySelector(":scope > .mobile-navigation-sheet-chrome");
    if (chrome instanceof HTMLElement) return chrome;

    chrome = document.createElement("div");
    chrome.className = "mobile-navigation-sheet-chrome";
    chrome.dataset.mobileNavigationChrome = "true";
    chrome.innerHTML = [
      '<div class="mobile-navigation-sheet-grip" aria-hidden="true"><span></span></div>',
      '<div class="mobile-navigation-sheet-heading">',
      '<span class="mobile-navigation-sheet-eyebrow">Navigation</span>',
      '<strong id="mobile-navigation-sheet-title">Chats and account</strong>',
      "</div>",
      '<button class="mobile-navigation-close" type="button" aria-label="Close navigation">',
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
      "</button>",
    ].join("");
    sidebar.insertBefore(chrome, sidebar.firstChild);

    chrome.querySelector(".mobile-navigation-close")?.addEventListener("click", () => {
      requestClose({ restoreFocus: true, source: "close-button" });
    });
    chrome.addEventListener("touchstart", handleGestureStart, { passive: true });
    chrome.addEventListener("touchmove", handleGestureMove, { passive: false });
    chrome.addEventListener("touchend", handleGestureEnd, { passive: true });
    chrome.addEventListener("touchcancel", cancelGesture, { passive: true });
    return chrome;
  }

  function ensureBackdropBinding() {
    const nextBackdrop = appContainer.querySelector(":scope > .sidebar-backdrop") || document.querySelector(".sidebar-backdrop");
    if (!(nextBackdrop instanceof HTMLElement)) return null;
    backdrop = nextBackdrop;
    if (!boundBackdrops.has(backdrop)) {
      boundBackdrops.add(backdrop);
      backdrop.addEventListener("click", () => {
        restoreFocusOnClose = true;
      }, { capture: true });
    }
    return backdrop;
  }

  function getFocusable() {
    return Array.from(sidebar.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((element) => (
        element instanceof HTMLElement
        && !element.hasAttribute("inert")
        && element.getAttribute("aria-hidden") !== "true"
        && element.offsetParent !== null
      ));
  }

  function focusCloseControl() {
    window.cancelAnimationFrame(focusFrame);
    focusFrame = window.requestAnimationFrame(() => {
      const closeButton = sidebar.querySelector(".mobile-navigation-close");
      if (closeButton instanceof HTMLElement && isOpen()) closeButton.focus({ preventScroll: true });
    });
  }

  function snapshotElementState(element) {
    if (!(element instanceof HTMLElement) || inertSnapshots.has(element)) return;
    inertSnapshots.set(element, {
      inert: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    });
  }

  function setUnderlyingPageInert(inert) {
    const targets = [mainContent, sidebarToggle].filter((element) => element instanceof HTMLElement);
    if (inert) {
      targets.forEach((element) => {
        snapshotElementState(element);
        element.setAttribute("inert", "");
        element.setAttribute("aria-hidden", "true");
      });
      return;
    }

    inertSnapshots.forEach((snapshot, element) => {
      if (!(element instanceof HTMLElement)) return;
      if (snapshot.inert) element.setAttribute("inert", "");
      else element.removeAttribute("inert");
      if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", snapshot.ariaHidden);
    });
    inertSnapshots.clear();
  }

  function captureInlineStyle(element, properties) {
    const style = {};
    properties.forEach((property) => {
      style[property] = element.style[property] || "";
    });
    return style;
  }

  function restoreInlineStyle(element, snapshot) {
    if (!(element instanceof HTMLElement) || !snapshot) return;
    Object.entries(snapshot).forEach(([property, value]) => {
      element.style[property] = value;
    });
  }

  function lockUnderlyingScroll() {
    if (scrollSnapshot) return;
    const root = document.documentElement;
    const body = document.body;
    scrollSnapshot = {
      x: window.scrollX,
      y: window.scrollY,
      chatScrollTop: chatMessages?.scrollTop || 0,
      rootStyle: captureInlineStyle(root, ["overflow", "overscrollBehavior"]),
      bodyStyle: captureInlineStyle(body, ["overflow", "overscrollBehavior"]),
    };
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    setClassIfChanged(body, "mobile-navigation-open", true);
  }

  function unlockUnderlyingScroll() {
    if (!scrollSnapshot) {
      setClassIfChanged(document.body, "mobile-navigation-open", false);
      return;
    }
    const snapshot = scrollSnapshot;
    scrollSnapshot = null;
    restoreInlineStyle(document.documentElement, snapshot.rootStyle);
    restoreInlineStyle(document.body, snapshot.bodyStyle);
    setClassIfChanged(document.body, "mobile-navigation-open", false);
    window.requestAnimationFrame(() => {
      window.scrollTo(snapshot.x, snapshot.y);
      if (chatMessages) chatMessages.scrollTop = snapshot.chatScrollTop;
    });
  }

  function restoreSidebarAttribute(name, value) {
    setAttr(sidebar, name, value);
  }

  function setSheetAccessibility(state) {
    if (!state.mobile) {
      restoreSidebarAttribute("role", originalSidebarAttributes.role);
      restoreSidebarAttribute("aria-modal", originalSidebarAttributes.ariaModal);
      restoreSidebarAttribute("aria-label", originalSidebarAttributes.ariaLabel);
      restoreSidebarAttribute("aria-labelledby", originalSidebarAttributes.ariaLabelledby);
      restoreSidebarAttribute("aria-hidden", originalSidebarAttributes.ariaHidden);
      restoreSidebarAttribute("tabindex", originalSidebarAttributes.tabIndex);
      if (originalSidebarAttributes.inert) sidebar.setAttribute("inert", "");
      else if (sidebar.hasAttribute("inert")) sidebar.removeAttribute("inert");
      return;
    }

    setAttr(sidebar, "role", "dialog");
    setAttr(sidebar, "aria-modal", state.ariaModal);
    setAttr(sidebar, "aria-labelledby", "mobile-navigation-sheet-title");
    setAttr(sidebar, "aria-hidden", state.sidebarHidden ? "true" : "false");
    setAttr(sidebar, "tabindex", "-1");
    if (state.sidebarHidden) {
      if (!sidebar.hasAttribute("inert")) sidebar.setAttribute("inert", "");
    } else if (sidebar.hasAttribute("inert")) sidebar.removeAttribute("inert");
  }

  function notify(reason, state) {
    const detail = Object.freeze({
      version: MOBILE_NAVIGATION_VERSION,
      reason,
      mobile: state.mobile,
      open: state.open,
      scrollLocked: Boolean(scrollSnapshot),
    });
    subscribers.forEach((listener) => {
      try { listener(detail); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-mobile-navigation-change", { detail }));
  }

  function sync(reason = "sync") {
    const mobile = isMobile();
    const open = mobile && sidebar.classList.contains("open");
    const state = deriveMobileNavigationState({ mobile, open });
    ensureSheetChrome();
    ensureBackdropBinding();

    sidebar.dataset.mobileNavigationVersion = MOBILE_NAVIGATION_VERSION;
    sidebar.dataset.mobileNavigationState = state.open ? "open" : (state.mobile ? "closed" : "desktop");
    setAttr(sidebarToggle, "aria-expanded", state.toggleExpanded);
    setAttr(sidebarToggle, "aria-label", state.open ? "Close navigation" : "Open navigation");
    setSheetAccessibility(state);

    if (state.open) {
      setUnderlyingPageInert(true);
      lockUnderlyingScroll();
      if (!lastOpen || !lastMobile) focusCloseControl();
    } else {
      setUnderlyingPageInert(false);
      unlockUnderlyingScroll();
      sidebar.style.removeProperty("--mobile-navigation-drag-y");
      setClassIfChanged(sidebar, "is-mobile-navigation-dragging", false);
      if (lastOpen && restoreFocusOnClose && mobile) {
        restoreFocusOnClose = false;
        window.requestAnimationFrame(() => sidebarToggle.focus({ preventScroll: true }));
      } else if (!open) {
        restoreFocusOnClose = false;
      }
    }

    if (!mobile && sidebar.classList.contains("open")) {
      setClassIfChanged(sidebar, "open", false);
      setClassIfChanged(document.body, "body-sidebar-open", false);
      const currentBackdrop = ensureBackdropBinding();
      if (currentBackdrop) setClassIfChanged(currentBackdrop, "visible", false);
    }

    const changed = open !== lastOpen || mobile !== lastMobile;
    lastOpen = open;
    lastMobile = mobile;
    if (changed || reason !== "mutation") notify(reason, state);
  }

  function requestClose(options = {}) {
    if (!sidebar.classList.contains("open")) return false;
    restoreFocusOnClose = options.restoreFocus !== false;
    const currentBackdrop = ensureBackdropBinding();
    if (currentBackdrop?.classList.contains("visible")) currentBackdrop.click();
    else if (sidebarToggle.getAttribute("aria-expanded") === "true") sidebarToggle.click();

    defer(() => {
      if (!sidebar.classList.contains("open")) return;
      setClassIfChanged(sidebar, "open", false);
      setAttr(sidebarToggle, "aria-expanded", "false");
      setClassIfChanged(document.body, "body-sidebar-open", false);
      if (currentBackdrop) setClassIfChanged(currentBackdrop, "visible", false);
      sync(options.source || "fallback-close");
    });
    return true;
  }

  function trapFocus(event) {
    if (event.key !== "Tab" || !isOpen()) return false;
    const focusable = getFocusable();
    if (!focusable.length) {
      event.preventDefault();
      sidebar.focus({ preventScroll: true });
      return true;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !sidebar.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
      return true;
    }
    if (!event.shiftKey && (active === last || !sidebar.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  function handleKeydown(event) {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose({ restoreFocus: true, source: "escape" });
      return;
    }
    trapFocus(event);
  }

  function handleOutsideTouchMove(event) {
    if (!isOpen()) return;
    const target = event.target;
    if (target instanceof Node && sidebar.contains(target)) return;
    event.preventDefault();
  }

  function handleGestureStart(event) {
    if (!isOpen() || event.touches.length !== 1) return;
    if (event.target?.closest?.("button, a, input, textarea, select")) return;
    const touch = event.touches[0];
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      startedAt: performance.now(),
      dragging: false,
    };
  }

  function handleGestureMove(event) {
    if (!gesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    gesture.currentX = touch.clientX;
    gesture.currentY = touch.clientY;
    const deltaY = touch.clientY - gesture.startY;
    const deltaX = touch.clientX - gesture.startX;
    if (deltaY <= 0 || Math.abs(deltaY) <= Math.abs(deltaX) * 1.05) return;
    gesture.dragging = true;
    event.preventDefault();
    setClassIfChanged(sidebar, "is-mobile-navigation-dragging", true);
    sidebar.style.setProperty("--mobile-navigation-drag-y", `${clampMobileNavigationDrag(deltaY)}px`);
  }

  function handleGestureEnd() {
    if (!gesture) return;
    const completed = gesture;
    gesture = null;
    const deltaY = completed.currentY - completed.startY;
    const deltaX = completed.currentX - completed.startX;
    const durationMs = performance.now() - completed.startedAt;
    setClassIfChanged(sidebar, "is-mobile-navigation-dragging", false);
    sidebar.style.removeProperty("--mobile-navigation-drag-y");
    if (completed.dragging && shouldCloseMobileNavigationGesture({ deltaY, deltaX, durationMs })) {
      requestClose({ restoreFocus: true, source: "swipe-down" });
    }
  }

  function cancelGesture() {
    gesture = null;
    setClassIfChanged(sidebar, "is-mobile-navigation-dragging", false);
    sidebar.style.removeProperty("--mobile-navigation-drag-y");
  }

  function updateViewportHeight() {
    window.cancelAnimationFrame(viewportFrame);
    viewportFrame = window.requestAnimationFrame(() => {
      const height = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
      if (height > 0) {
        const next = `${Math.round(height)}px`;
        if (document.documentElement.style.getPropertyValue("--mobile-navigation-viewport-height") !== next) {
          document.documentElement.style.setProperty("--mobile-navigation-viewport-height", next);
        }
      }
    });
  }

  function handleViewportChange() {
    updateViewportHeight();
    if (!isMobile() && sidebar.classList.contains("open")) {
      requestClose({ restoreFocus: false, source: "desktop-transition" });
    }
    sync("viewport-change");
  }

  ensureSheetChrome();
  updateViewportHeight();
  sidebarToggle.addEventListener("click", () => {
    if (isOpen()) restoreFocusOnClose = true;
    defer(() => sync("toggle"));
  }, { capture: true });
  document.addEventListener("keydown", handleKeydown, { capture: true });
  document.addEventListener("touchmove", handleOutsideTouchMove, { passive: false });
  media?.addEventListener?.("change", handleViewportChange);
  window.addEventListener("resize", handleViewportChange, { passive: true });
  window.visualViewport?.addEventListener?.("resize", updateViewportHeight, { passive: true });
  window.addEventListener("orientationchange", handleViewportChange, { passive: true });

  let observedOpen = sidebar.classList.contains("open");
  new MutationObserver(() => {
    const nextOpen = sidebar.classList.contains("open");
    if (nextOpen === observedOpen) return;
    observedOpen = nextOpen;
    sync("mutation");
    observedOpen = sidebar.classList.contains("open");
  }).observe(sidebar, { attributes: true, attributeFilter: ["class"] });

  new MutationObserver(() => ensureBackdropBinding()).observe(appContainer, { childList: true });

  window.SentIQMobileNavigation = Object.freeze({
    version: MOBILE_NAVIGATION_VERSION,
    isMobile,
    isOpen,
    close: requestClose,
    refresh: () => sync("manual"),
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false) {
        listener(Object.freeze({
          version: MOBILE_NAVIGATION_VERSION,
          reason: "subscribe",
          mobile: isMobile(),
          open: isOpen(),
          scrollLocked: Boolean(scrollSnapshot),
        }));
      }
      return () => subscribers.delete(listener);
    },
  });

  document.documentElement.dataset.mobileNavigationVersion = MOBILE_NAVIGATION_VERSION;
  sync("initial");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeMobileNavigation, { once: true });
else initializeMobileNavigation();
