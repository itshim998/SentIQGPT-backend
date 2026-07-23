/* SentIQ Chat — production scroll interaction guard

   Manual wheel, touch, and keyboard scrolling must always win over delayed
   reading-position corrections. This module loads immediately before the
   long-answer reading runtime so its guarded native scroll method is captured
   by that runtime rather than bypassed.
*/

export const SCROLL_INTERACTION_GUARD_VERSION = "12.5.1";
export const MANUAL_SCROLL_HOLD_MS = 360;
export const EXPLICIT_NAVIGATION_HOLD_MS = 1100;

export function shouldAllowProgrammaticScroll(state = {}) {
  const timestamp = Number(state.now) || 0;
  const manualUntil = Number(state.manualUntil) || 0;
  const explicitUntil = Number(state.explicitUntil) || 0;
  return timestamp > manualUntil || timestamp <= explicitUntil;
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
  const manualKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  let manualUntil = 0;
  let explicitUntil = 0;
  let settleTimer = 0;

  function now() {
    return window.performance?.now?.() || Date.now();
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
    const timestamp = now();
    if (!shouldAllowProgrammaticScroll({ now: timestamp, manualUntil, explicitUntil })) {
      root.dataset.sentiqScrollCorrection = "blocked-during-manual-scroll";
      return undefined;
    }
    delete root.dataset.sentiqScrollCorrection;
    if (nativeScrollTo) return nativeScrollTo(...args);

    const request = args[0];
    const top = typeof request === "number"
      ? Number(args[1])
      : Number(request?.top);
    if (Number.isFinite(top)) chatMessages.scrollTop = Math.max(0, top);
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

  chatMessages.addEventListener("wheel", markManualIntent, { capture: true, passive: true });
  chatMessages.addEventListener("touchmove", markManualIntent, { capture: true, passive: true });
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

  window.SentIQScrollInteractionGuard = Object.freeze({
    version: SCROLL_INTERACTION_GUARD_VERSION,
    markManualIntent,
    markExplicitNavigation,
    getState() {
      return Object.freeze({
        manual: now() <= manualUntil,
        manualUntil,
        explicitUntil,
      });
    },
  });

  root.dataset.sentiqScrollInteractionGuard = SCROLL_INTERACTION_GUARD_VERSION;
}

initializeScrollInteractionGuard();
