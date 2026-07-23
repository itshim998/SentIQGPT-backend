/* SentIQ Chat — production scroll interaction guard

   Manual wheel, touch, pointer, and keyboard scrolling must always win over
   delayed reading-position corrections. This module loads immediately before
   the long-answer reading runtime and protects both programmatic scroll APIs:
   scrollTo(...) and direct scrollTop assignments.
*/

export const SCROLL_INTERACTION_GUARD_VERSION = "12.5.2";
export const MANUAL_SCROLL_HOLD_MS = 3200;
export const EXPLICIT_NAVIGATION_HOLD_MS = 1100;

export function shouldAllowProgrammaticScroll(state = {}) {
  const timestamp = Number(state.now) || 0;
  const manualUntil = Number(state.manualUntil) || 0;
  const explicitUntil = Number(state.explicitUntil) || 0;
  return timestamp > manualUntil || timestamp <= explicitUntil;
}

function findPropertyDescriptor(target, property) {
  let prototype = target;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

function initializeScrollInteractionGuard() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQScrollInteractionGuard?.version === SCROLL_INTERACTION_GUARD_VERSION) return;

  const root = document.documentElement;
  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;

  const nativeScrollTo = typeof chatMessages.scrollTo === "function"
    ? chatMessages.scrollTo.bind(chatMessages)
    : null;
  const scrollTopDescriptor = findPropertyDescriptor(Object.getPrototypeOf(chatMessages), "scrollTop");
  const manualKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  let manualUntil = 0;
  let explicitUntil = 0;
  let settleTimer = 0;
  let scrollTopProtected = false;

  function now() {
    return window.performance?.now?.() || Date.now();
  }

  function allowsProgrammaticScroll(timestamp = now()) {
    return shouldAllowProgrammaticScroll({ now: timestamp, manualUntil, explicitUntil });
  }

  function markBlocked(kind) {
    root.dataset.sentiqScrollCorrection = `blocked-${kind}-during-manual-scroll`;
  }

  function markAllowed() {
    delete root.dataset.sentiqScrollCorrection;
  }

  function readNativeScrollTop() {
    if (typeof scrollTopDescriptor?.get === "function") {
      return Number(scrollTopDescriptor.get.call(chatMessages)) || 0;
    }
    return 0;
  }

  function writeNativeScrollTop(value) {
    const normalized = Math.max(0, Number(value) || 0);
    if (typeof scrollTopDescriptor?.set === "function") {
      scrollTopDescriptor.set.call(chatMessages, normalized);
      return;
    }
    nativeScrollTo?.({ top: normalized, behavior: "auto" });
  }

  function syncManualState() {
    window.clearTimeout(settleTimer);
    const delay = Math.max(0, manualUntil - now()) + 24;
    settleTimer = window.setTimeout(() => {
      if (now() < manualUntil) {
        syncManualState();
        return;
      }
      delete root.dataset.sentiqManualScroll;
    }, delay);
  }

  function markManualIntent() {
    manualUntil = now() + MANUAL_SCROLL_HOLD_MS;
    root.dataset.sentiqManualScroll = "active";
    syncManualState();
  }

  function markExplicitNavigation() {
    explicitUntil = now() + EXPLICIT_NAVIGATION_HOLD_MS;
  }

  function guardedNativeScrollTo(...args) {
    if (!allowsProgrammaticScroll()) {
      markBlocked("scrollto");
      return undefined;
    }
    markAllowed();
    if (nativeScrollTo) return nativeScrollTo(...args);

    const request = args[0];
    const top = typeof request === "number"
      ? Number(args[1])
      : Number(request?.top);
    if (Number.isFinite(top)) writeNativeScrollTop(top);
    return undefined;
  }

  try {
    Object.defineProperty(chatMessages, "scrollTo", {
      configurable: true,
      writable: true,
      value: guardedNativeScrollTo,
    });
  } catch {
    try { chatMessages.scrollTo = guardedNativeScrollTo; } catch { /* native method remains */ }
  }

  if (typeof scrollTopDescriptor?.get === "function" && typeof scrollTopDescriptor?.set === "function") {
    try {
      Object.defineProperty(chatMessages, "scrollTop", {
        configurable: true,
        enumerable: Boolean(scrollTopDescriptor.enumerable),
        get: readNativeScrollTop,
        set(value) {
          if (!allowsProgrammaticScroll()) {
            markBlocked("scrolltop");
            return;
          }
          markAllowed();
          writeNativeScrollTop(value);
        },
      });
      scrollTopProtected = true;
    } catch {
      scrollTopProtected = false;
    }
  }

  chatMessages.addEventListener("wheel", markManualIntent, { capture: true, passive: true });
  chatMessages.addEventListener("touchmove", markManualIntent, { capture: true, passive: true });
  chatMessages.addEventListener("pointerdown", markManualIntent, { capture: true, passive: true });
  chatMessages.addEventListener("keydown", (event) => {
    if (manualKeys.has(event.key)) markManualIntent();
  }, true);

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(
      "#scroll-anchor-pill, #send-btn, #new-chat-btn, .long-answer-source-jump, .long-answer-source-return",
    )) {
      markExplicitNavigation();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.key === "Enter" && !event.shiftKey && event.target.closest("#chat-input")) {
      markExplicitNavigation();
    }
  }, true);

  window.SentIQScrollInteractionGuard = Object.freeze({
    version: SCROLL_INTERACTION_GUARD_VERSION,
    markManualIntent,
    markExplicitNavigation,
    allowsProgrammaticScroll,
    getState() {
      return Object.freeze({
        manual: now() <= manualUntil,
        manualUntil,
        explicitUntil,
        scrollTopProtected,
      });
    },
  });

  root.dataset.sentiqScrollInteractionGuard = SCROLL_INTERACTION_GUARD_VERSION;
  root.dataset.sentiqScrollTopProtected = scrollTopProtected ? "true" : "false";
}

initializeScrollInteractionGuard();
