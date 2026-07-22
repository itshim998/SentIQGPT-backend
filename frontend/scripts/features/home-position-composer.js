/* ============================================================
   SentIQ Liquid Glass V4 — Phase 4.3
   Home-position composer transition

   The existing main-content empty state remains the single source of truth.
   This module only animates the same composer between its empty-chat and
   persistent positions; it does not create, clone, or submit a composer.
   ============================================================ */

const EMPTY_CHAT_CLASS = "is-empty-chat";
const TRANSITIONING_CLASS = "composer-layout-transitioning";

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function isRenderable(element) {
  if (!element || element.hidden || element.style?.display === "none") return false;
  return element.getClientRects().length > 0;
}

function initializeHomePositionComposer() {
  const mainContent = document.querySelector(".main-content");
  const composer = mainContent?.querySelector(":scope > .chat-input-wrapper");

  if (!mainContent || !composer) return;

  let emptyState = mainContent.classList.contains(EMPTY_CHAT_CLASS);
  let lastStableRect = null;
  let transitionPending = false;
  let activeAnimation = null;
  let resizeFrame = 0;

  function captureStableRect() {
    if (!isRenderable(composer)) return;
    const rect = composer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) lastStableRect = rect;
  }

  function finishTransition() {
    transitionPending = false;
    activeAnimation = null;
    mainContent.classList.remove(TRANSITIONING_CLASS);
    captureStableRect();
  }

  function animateToCurrentPosition(previousRect, nextEmptyState) {
    if (!previousRect || !isRenderable(composer)) {
      finishTransition();
      return;
    }

    const nextRect = composer.getBoundingClientRect();
    const deltaX = previousRect.left - nextRect.left;
    const deltaY = previousRect.top - nextRect.top;
    const distance = Math.hypot(deltaX, deltaY);

    if (
      prefersReducedMotion()
      || typeof composer.animate !== "function"
      || !Number.isFinite(distance)
      || distance < 2
    ) {
      lastStableRect = nextRect;
      finishTransition();
      return;
    }

    activeAnimation?.cancel();
    mainContent.classList.add(TRANSITIONING_CLASS);

    const animation = composer.animate(
      [
        {
          transform: `translate3d(${deltaX}px, ${deltaY}px, 0)`,
          opacity: nextEmptyState ? 0.96 : 0.94,
        },
        {
          transform: "translate3d(0, 0, 0)",
          opacity: 1,
        },
      ],
      {
        duration: nextEmptyState ? 380 : 460,
        easing: nextEmptyState
          ? "cubic-bezier(0.22, 1, 0.36, 1)"
          : "cubic-bezier(0.2, 0.82, 0.24, 1)",
        fill: "both",
      },
    );

    activeAnimation = animation;
    animation.finished.then(
      () => {
        if (activeAnimation !== animation) return;
        activeAnimation = null;
        animation.cancel();
        finishTransition();
      },
      () => {
        if (activeAnimation === animation) finishTransition();
      },
    );
  }

  const stateObserver = new MutationObserver(() => {
    const nextEmptyState = mainContent.classList.contains(EMPTY_CHAT_CLASS);
    if (nextEmptyState === emptyState) return;

    const previousRect = lastStableRect || composer.getBoundingClientRect();
    emptyState = nextEmptyState;
    transitionPending = true;

    window.requestAnimationFrame(() => {
      animateToCurrentPosition(previousRect, nextEmptyState);
    });
  });

  stateObserver.observe(mainContent, {
    attributes: true,
    attributeFilter: ["class"],
  });

  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
      if (transitionPending || activeAnimation) return;
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        captureStableRect();
      });
    })
    : null;

  resizeObserver?.observe(mainContent);
  resizeObserver?.observe(composer);

  window.addEventListener("resize", () => {
    if (transitionPending || activeAnimation) return;
    if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      captureStableRect();
    });
  }, { passive: true });

  window.requestAnimationFrame(captureStableRect);
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeHomePositionComposer, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
