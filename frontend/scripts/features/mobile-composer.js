/* SentIQ Chat — Phase 10.2 visualViewport-aware mobile composer */

import {
  MOBILE_COMPOSER_VERSION,
  deriveActionMenuMaxHeight,
  deriveMobileComposerMetrics,
  deriveScrollRestore,
  isMobileComposerViewport,
} from "./mobile-composer-state.mjs";

const COARSE_POINTER_QUERY = "(pointer: coarse)";
const ACTIVE_INPUT_SELECTOR = "textarea, input, select, [contenteditable='true']";

function initializeMobileComposer() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQMobileComposer?.version === MOBILE_COMPOSER_VERSION) return;

  const root = document.documentElement;
  const body = document.body;
  const appContainer = document.querySelector(".app-container");
  const mainContent = document.querySelector(".main-content");
  const chatScrollRegion = document.querySelector(".chat-scroll-region");
  const chatMessages = document.getElementById("chat-messages");
  const composerWrapper = document.querySelector(".chat-input-wrapper");
  const composerArea = document.querySelector(".chat-input-area");
  const chatInput = document.getElementById("chat-input");
  const composerActionMenu = document.getElementById("composer-action-menu");
  const executionModeControl = document.getElementById("execution-mode-control");
  const executionModeMenu = document.getElementById("execution-mode-menu");

  if (
    !(appContainer instanceof HTMLElement)
    || !(mainContent instanceof HTMLElement)
    || !(composerWrapper instanceof HTMLElement)
    || !(composerArea instanceof HTMLElement)
    || !(chatInput instanceof HTMLTextAreaElement)
  ) return;

  const coarsePointerMedia = window.matchMedia?.(COARSE_POINTER_QUERY) || null;
  const baselines = new Map();
  const subscribers = new Set();
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => schedule("resize-observer"))
    : null;

  let frame = 0;
  let postLayoutFrame = 0;
  let textareaFrame = 0;
  let lastState = null;
  let focusScrollSnapshot = null;
  let lastReason = "initial";
  let sizingTextarea = false;

  function getVisualViewportSnapshot() {
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth || root.clientWidth || 1;
    const height = viewport?.height || window.innerHeight || root.clientHeight || 1;
    const offsetTop = viewport?.offsetTop || 0;
    return { width, height, offsetTop };
  }

  function getPhysicalOrientation(snapshot) {
    const screenOrientation = String(window.screen?.orientation?.type || "").toLowerCase();
    if (screenOrientation.includes("landscape")) return "landscape";
    if (screenOrientation.includes("portrait")) return "portrait";

    const legacyOrientation = Number(window.orientation);
    if (Number.isFinite(legacyOrientation)) {
      return Math.abs(legacyOrientation) === 90 ? "landscape" : "portrait";
    }

    const screenWidth = Number(window.screen?.width) || 0;
    const screenHeight = Number(window.screen?.height) || 0;
    if (screenWidth > 0 && screenHeight > 0 && screenWidth !== screenHeight) {
      return screenWidth > screenHeight ? "landscape" : "portrait";
    }

    return snapshot.width > snapshot.height ? "landscape" : "portrait";
  }

  function isTextareaFocused() {
    return document.activeElement === chatInput;
  }

  function captureScrollSnapshot() {
    if (!(chatMessages instanceof HTMLElement)) return null;
    return {
      previousScrollTop: chatMessages.scrollTop,
      previousScrollHeight: chatMessages.scrollHeight,
      previousClientHeight: chatMessages.clientHeight,
    };
  }

  function restoreScrollSnapshot(snapshot) {
    if (!snapshot || !(chatMessages instanceof HTMLElement)) return;
    const nextScrollTop = deriveScrollRestore({
      ...snapshot,
      nextScrollHeight: chatMessages.scrollHeight,
      nextClientHeight: chatMessages.clientHeight,
    });
    if (Math.abs(chatMessages.scrollTop - nextScrollTop) > 0.5) {
      chatMessages.scrollTop = nextScrollTop;
    }
  }

  function getBaselineHeight(snapshot, textareaFocused) {
    const orientation = getPhysicalOrientation(snapshot);
    const layoutHeight = Math.max(
      snapshot.height,
      window.innerHeight || 0,
      root.clientHeight || 0,
    );
    const current = baselines.get(orientation) || 0;
    const candidate = Math.max(snapshot.height, layoutHeight);

    if (!textareaFocused || candidate > current) {
      baselines.set(orientation, candidate);
      return candidate;
    }

    if (current > 0) return current;

    const screenWidth = Number(window.screen?.width) || snapshot.width;
    const screenHeight = Number(window.screen?.height) || snapshot.height;
    const orientationEstimate = orientation === "landscape"
      ? Math.min(screenWidth, screenHeight)
      : Math.max(screenWidth, screenHeight);
    const estimated = Math.max(snapshot.height, Math.min(orientationEstimate, snapshot.height * 2.2));
    baselines.set(orientation, estimated);
    return estimated;
  }

  function setDataset(element, name, value) {
    if (!(element instanceof HTMLElement) && element !== root) return;
    element.dataset[name] = String(value);
  }

  function setRootProperty(name, value) {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  }

  function applyState(state) {
    setDataset(root, "mobileComposerVersion", MOBILE_COMPOSER_VERSION);
    setDataset(root, "mobileComposerActive", state.active ? "true" : "false");
    setDataset(root, "mobileComposerKeyboard", state.keyboardOpen ? "open" : "closed");
    setDataset(root, "mobileComposerOrientation", state.orientation);
    setDataset(root, "mobileComposerCompact", state.compact ? "true" : "false");
    setDataset(root, "mobileComposerSafeArea", state.safeAreaMode);
    setDataset(mainContent, "mobileComposerVersion", MOBILE_COMPOSER_VERSION);
    setDataset(composerWrapper, "mobileComposerVersion", MOBILE_COMPOSER_VERSION);
    setDataset(composerArea, "mobileComposerVersion", MOBILE_COMPOSER_VERSION);

    body.classList.toggle("mobile-composer-active", state.active);
    body.classList.toggle("mobile-composer-keyboard-open", state.active && state.keyboardOpen);

    setRootProperty("--mobile-composer-viewport-width", `${state.visualWidth}px`);
    setRootProperty("--mobile-composer-viewport-height", `${state.visualHeight}px`);
    setRootProperty("--mobile-composer-viewport-top", `${state.viewportTop}px`);
    setRootProperty("--mobile-composer-keyboard-inset", `${state.keyboardInset}px`);
    setRootProperty("--mobile-composer-textarea-max-height", `${state.textareaMaxHeight}px`);
  }

  function clearInactiveSizing() {
    composerWrapper.removeAttribute("data-mobile-composer-textarea-overflow");
    chatInput.style.removeProperty("height");
    chatInput.style.removeProperty("max-height");
    chatInput.style.removeProperty("overflow-y");
    root.style.removeProperty("--mobile-composer-action-menu-max-height");
  }

  function resizeTextarea(state = lastState) {
    window.cancelAnimationFrame(textareaFrame);
    textareaFrame = window.requestAnimationFrame(() => {
      if (!state?.active || sizingTextarea) {
        if (!state?.active) clearInactiveSizing();
        return;
      }

      sizingTextarea = true;
      const computed = window.getComputedStyle(chatInput);
      const minHeight = Math.max(40, Number.parseFloat(computed.minHeight) || 44);
      const maxHeight = Math.max(minHeight, state.textareaMaxHeight);
      const previousHeight = chatInput.style.height;
      chatInput.style.height = "auto";
      chatInput.style.maxHeight = `${maxHeight}px`;
      const naturalHeight = Math.max(minHeight, chatInput.scrollHeight);
      const nextHeight = Math.min(naturalHeight, maxHeight);
      const nextValue = `${Math.round(nextHeight)}px`;
      if (previousHeight !== nextValue) chatInput.style.height = nextValue;
      else chatInput.style.height = previousHeight;
      const overflowing = naturalHeight > maxHeight + 1;
      chatInput.style.overflowY = overflowing ? "auto" : "hidden";
      composerWrapper.dataset.mobileComposerTextareaOverflow = overflowing ? "true" : "false";
      sizingTextarea = false;
    });
  }

  function updateMenuBounds(state) {
    if (!state.active) return;
    const composerRect = composerWrapper.getBoundingClientRect();
    const maxHeight = deriveActionMenuMaxHeight({
      composerTop: composerRect.top,
      viewportTop: state.viewportTop,
      visualHeight: state.visualHeight,
      orientation: state.orientation,
      keyboardOpen: state.keyboardOpen,
    });
    setRootProperty("--mobile-composer-action-menu-max-height", `${maxHeight}px`);
  }

  function notify(reason, state) {
    const detail = Object.freeze({
      version: MOBILE_COMPOSER_VERSION,
      reason,
      active: state.active,
      keyboardOpen: state.keyboardOpen,
      orientation: state.orientation,
      viewportHeight: state.visualHeight,
      keyboardInset: state.keyboardInset,
      textareaMaxHeight: state.textareaMaxHeight,
    });
    subscribers.forEach((listener) => {
      try { listener(detail); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-mobile-composer-change", { detail }));
  }

  function measure(reason = lastReason) {
    lastReason = reason;
    const snapshot = getVisualViewportSnapshot();
    const textareaFocused = isTextareaFocused();
    const baselineHeight = getBaselineHeight(snapshot, textareaFocused);
    const orientation = getPhysicalOrientation(snapshot);
    const nextState = deriveMobileComposerMetrics({
      visualWidth: snapshot.width,
      visualHeight: snapshot.height,
      orientation,
      viewportTop: snapshot.offsetTop,
      baselineHeight,
      textareaFocused,
      coarsePointer: Boolean(coarsePointerMedia?.matches),
    });
    const keyboardTransition = Boolean(
      nextState.keyboardOpen
      && !lastState?.keyboardOpen
      && focusScrollSnapshot
    );
    const scrollSnapshot = keyboardTransition
      ? focusScrollSnapshot
      : captureScrollSnapshot();

    applyState(nextState);
    lastState = nextState;
    resizeTextarea(nextState);

    window.cancelAnimationFrame(postLayoutFrame);
    postLayoutFrame = window.requestAnimationFrame(() => {
      updateMenuBounds(nextState);
      restoreScrollSnapshot(scrollSnapshot);
      if (!nextState.keyboardOpen && !textareaFocused) focusScrollSnapshot = null;
      notify(reason, nextState);
    });
  }

  function schedule(reason = "scheduled") {
    lastReason = reason;
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      measure(reason);
    });
  }

  function handleFocusIn(event) {
    if (event.target !== chatInput) return;
    focusScrollSnapshot = captureScrollSnapshot();
    const snapshot = getVisualViewportSnapshot();
    const orientation = getPhysicalOrientation(snapshot);
    baselines.set(orientation, Math.max(
      baselines.get(orientation) || 0,
      snapshot.height,
      window.innerHeight || 0,
      root.clientHeight || 0,
    ));
    schedule("textarea-focus");
  }

  function handleFocusOut(event) {
    if (event.target !== chatInput) return;
    window.setTimeout(() => schedule("textarea-blur"), 0);
  }

  function handleViewportChange() {
    schedule("visual-viewport");
  }

  function handleWindowResize() {
    schedule("window-resize");
  }

  function handleOrientationChange() {
    window.setTimeout(() => schedule("orientation-change"), 0);
    window.setTimeout(() => schedule("orientation-settled"), 180);
  }

  function handleComposerInput() {
    resizeTextarea(lastState);
    schedule("textarea-input");
  }

  function handlePointerChange() {
    schedule("pointer-change");
  }

  function handleDocumentPointerDown(event) {
    if (!lastState?.active || !(event.target instanceof Element)) return;
    if (!event.target.closest(ACTIVE_INPUT_SELECTOR)) return;
    schedule("interactive-focus");
  }

  const menuObserver = new MutationObserver(() => schedule("menu-state"));
  if (composerActionMenu instanceof HTMLElement) {
    menuObserver.observe(composerActionMenu, { attributes: true, attributeFilter: ["class", "aria-hidden"] });
  }
  if (executionModeControl instanceof HTMLElement) {
    menuObserver.observe(executionModeControl, { attributes: true, attributeFilter: ["class"] });
  }
  if (executionModeMenu instanceof HTMLElement) {
    menuObserver.observe(executionModeMenu, { attributes: true, attributeFilter: ["aria-hidden"] });
  }

  document.addEventListener("focusin", handleFocusIn, { capture: true });
  document.addEventListener("focusout", handleFocusOut, { capture: true });
  document.addEventListener("pointerdown", handleDocumentPointerDown, { capture: true, passive: true });
  chatInput.addEventListener("input", handleComposerInput, { passive: true });
  chatInput.addEventListener("change", handleComposerInput, { passive: true });
  window.visualViewport?.addEventListener?.("resize", handleViewportChange, { passive: true });
  window.visualViewport?.addEventListener?.("scroll", handleViewportChange, { passive: true });
  window.addEventListener("resize", handleWindowResize, { passive: true });
  window.addEventListener("orientationchange", handleOrientationChange, { passive: true });
  coarsePointerMedia?.addEventListener?.("change", handlePointerChange);

  resizeObserver?.observe(composerWrapper);
  resizeObserver?.observe(chatInput);
  if (chatScrollRegion instanceof HTMLElement) resizeObserver?.observe(chatScrollRegion);

  window.SentIQMobileComposer = Object.freeze({
    version: MOBILE_COMPOSER_VERSION,
    isActive() {
      const viewport = getVisualViewportSnapshot();
      return isMobileComposerViewport({
        width: viewport.width,
        height: viewport.height,
        coarsePointer: Boolean(coarsePointerMedia?.matches),
      });
    },
    getState() {
      return lastState ? Object.freeze({ ...lastState }) : null;
    },
    refresh() {
      schedule("manual");
    },
    resizeTextarea() {
      resizeTextarea(lastState);
    },
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false && lastState) {
        listener(Object.freeze({
          version: MOBILE_COMPOSER_VERSION,
          reason: "subscribe",
          active: lastState.active,
          keyboardOpen: lastState.keyboardOpen,
          orientation: lastState.orientation,
          viewportHeight: lastState.visualHeight,
          keyboardInset: lastState.keyboardInset,
          textareaMaxHeight: lastState.textareaMaxHeight,
        }));
      }
      return () => subscribers.delete(listener);
    },
  });

  schedule("initial");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMobileComposer, { once: true });
} else {
  initializeMobileComposer();
}
