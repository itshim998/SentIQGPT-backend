/* ============================================================
   SentIQ Liquid Glass V4 — Phase 5.1
   Advanced liquid composer structure

   The existing composer DOM remains authoritative. This module adds
   resilient textarea sizing, semantic visual state, and height-stable
   expansion for attachments and active composer modes.
   ============================================================ */

const COMPOSER_READY_CLASS = "advanced-liquid-composer-ready";
const SIZE_TRANSITION_CLASS = "composer-size-transitioning";
const TEXTAREA_MULTILINE_CLASS = "composer-textarea-multiline";

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function elementIsVisible(element) {
  if (!element || element.hidden) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function parsePixelValue(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function initializeAdvancedLiquidComposer() {
  const wrapper = document.querySelector(".chat-input-wrapper");
  const surface = wrapper?.querySelector(":scope > .chat-input-area");
  const textarea = surface?.querySelector("#chat-input");
  const attachmentArea = surface?.querySelector("#file-preview-area");
  const sendButton = surface?.querySelector("#send-btn");
  const liveButton = surface?.querySelector("#live-beta-btn");
  const plusButton = surface?.querySelector("#composer-plus-btn");
  const executionControl = surface?.querySelector("#execution-mode-control");
  const modeBars = Array.from(surface?.querySelectorAll(".composer-mode-pill") || []);

  if (!wrapper || !surface || !textarea || !attachmentArea || !sendButton) return;
  if (surface.classList.contains(COMPOSER_READY_CLASS)) return;

  surface.classList.add(COMPOSER_READY_CLASS);
  wrapper.dataset.composerVersion = "5.1";

  let resizeFrame = 0;
  let stableSurfaceHeight = 0;
  let activeHeightTimer = 0;
  let suppressResizeCapture = false;

  function syncTextareaHeight() {
    const styles = window.getComputedStyle(textarea);
    const minHeight = parsePixelValue(styles.minHeight, 44);
    const maxHeight = parsePixelValue(styles.maxHeight, 168);

    textarea.style.height = "auto";
    const contentHeight = Math.max(textarea.scrollHeight, minHeight);
    const nextHeight = Math.min(contentHeight, maxHeight);
    textarea.style.height = `${Math.round(nextHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight + 1 ? "auto" : "hidden";

    surface.classList.toggle(TEXTAREA_MULTILINE_CLASS, nextHeight > minHeight + 8);
    surface.classList.toggle("composer-has-value", Boolean(textarea.value.trim()));
  }

  function resolveActionState() {
    if (sendButton.classList.contains("is-stop")) return "stop";
    if (elementIsVisible(liveButton)) return "live";
    return "send";
  }

  function syncComposerState() {
    surface.dataset.actionState = resolveActionState();
    surface.classList.toggle("composer-has-attachments", !attachmentArea.hidden && attachmentArea.childElementCount > 0);
    surface.classList.toggle("composer-has-mode", modeBars.some(elementIsVisible));
    surface.classList.toggle("composer-menu-open", Boolean(plusButton?.classList.contains("active")));
    surface.classList.toggle("composer-execution-open", Boolean(executionControl?.classList.contains("open")));
  }

  function clearHeightTransition() {
    if (activeHeightTimer) {
      window.clearTimeout(activeHeightTimer);
      activeHeightTimer = 0;
    }
    surface.classList.remove(SIZE_TRANSITION_CLASS);
    surface.style.removeProperty("height");
    surface.style.removeProperty("overflow");
    suppressResizeCapture = false;
    stableSurfaceHeight = surface.getBoundingClientRect().height;
  }

  function animateSurfaceHeight(previousHeight) {
    const nextHeight = surface.getBoundingClientRect().height;
    const fromHeight = Number.isFinite(previousHeight) && previousHeight > 0
      ? previousHeight
      : stableSurfaceHeight;

    if (
      prefersReducedMotion()
      || !Number.isFinite(fromHeight)
      || !Number.isFinite(nextHeight)
      || Math.abs(nextHeight - fromHeight) < 2
    ) {
      stableSurfaceHeight = nextHeight;
      return;
    }

    if (activeHeightTimer) window.clearTimeout(activeHeightTimer);
    suppressResizeCapture = true;
    surface.classList.add(SIZE_TRANSITION_CLASS);
    surface.style.height = `${Math.round(fromHeight)}px`;
    surface.style.overflow = "clip";
    void surface.offsetHeight;

    window.requestAnimationFrame(() => {
      surface.style.height = `${Math.round(nextHeight)}px`;
    });

    activeHeightTimer = window.setTimeout(clearHeightTransition, 300);
  }

  function handleStructuralMutation() {
    const previousHeight = stableSurfaceHeight || surface.getBoundingClientRect().height;
    syncComposerState();
    window.requestAnimationFrame(() => animateSurfaceHeight(previousHeight));
  }

  textarea.addEventListener("input", syncTextareaHeight);
  textarea.addEventListener("change", syncTextareaHeight);
  textarea.addEventListener("compositionend", syncTextareaHeight);

  const stateObserver = new MutationObserver((mutations) => {
    const structuralChange = mutations.some((mutation) => (
      mutation.type === "childList"
      || mutation.target === attachmentArea
      || modeBars.includes(mutation.target)
    ));

    syncComposerState();
    if (structuralChange) handleStructuralMutation();
  });

  stateObserver.observe(surface, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "style", "disabled", "aria-expanded"],
  });

  const surfaceResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
      if (suppressResizeCapture) return;
      stableSurfaceHeight = surface.getBoundingClientRect().height;
    })
    : null;

  surfaceResizeObserver?.observe(surface);

  window.addEventListener("resize", () => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      syncTextareaHeight();
      stableSurfaceHeight = surface.getBoundingClientRect().height;
    });
  }, { passive: true });

  surface.addEventListener("transitionend", (event) => {
    if (event.target === surface && event.propertyName === "height") clearHeightTransition();
  });

  syncTextareaHeight();
  syncComposerState();
  window.requestAnimationFrame(() => {
    stableSurfaceHeight = surface.getBoundingClientRect().height;
  });
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeAdvancedLiquidComposer, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
