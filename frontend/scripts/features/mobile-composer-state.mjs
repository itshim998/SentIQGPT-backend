/* SentIQ Chat — Phase 10.2 mobile composer state model */

export const MOBILE_COMPOSER_VERSION = "10.2";
export const MOBILE_COMPOSER_BREAKPOINT_PX = 768;
export const MOBILE_COMPOSER_LANDSCAPE_MAX_WIDTH_PX = 1024;
export const MOBILE_COMPOSER_LANDSCAPE_MAX_HEIGHT_PX = 560;
export const MOBILE_COMPOSER_KEYBOARD_MIN_INSET_PX = 72;
export const MOBILE_COMPOSER_SCROLL_ANCHOR_THRESHOLD_PX = 72;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(min, value, max) {
  return Math.min(max, Math.max(min, value));
}

export function getMobileComposerOrientation(width, height) {
  return finiteNumber(width) > finiteNumber(height) ? "landscape" : "portrait";
}

export function isMobileComposerViewport(input = {}) {
  const width = Math.max(0, finiteNumber(input.width, Number.POSITIVE_INFINITY));
  const height = Math.max(0, finiteNumber(input.height, Number.POSITIVE_INFINITY));
  const coarsePointer = Boolean(input.coarsePointer);
  return Boolean(
    width <= MOBILE_COMPOSER_BREAKPOINT_PX
      || (
        coarsePointer
        && width <= MOBILE_COMPOSER_LANDSCAPE_MAX_WIDTH_PX
        && height <= MOBILE_COMPOSER_LANDSCAPE_MAX_HEIGHT_PX
      )
  );
}

export function getKeyboardThreshold(baselineHeight) {
  const baseline = Math.max(1, finiteNumber(baselineHeight, 1));
  return clamp(MOBILE_COMPOSER_KEYBOARD_MIN_INSET_PX, Math.round(baseline * 0.14), 112);
}

export function deriveTextareaMaxHeight(input = {}) {
  const height = Math.max(1, finiteNumber(input.visualHeight, 1));
  const orientation = input.orientation === "landscape" ? "landscape" : "portrait";
  const keyboardOpen = Boolean(input.keyboardOpen);

  if (orientation === "landscape") {
    return keyboardOpen
      ? clamp(60, Math.round(height * 0.2), 88)
      : clamp(72, Math.round(height * 0.26), 112);
  }

  return keyboardOpen
    ? clamp(88, Math.round(height * 0.24), 132)
    : clamp(112, Math.round(height * 0.28), 168);
}

export function deriveActionMenuMaxHeight(input = {}) {
  const composerTop = finiteNumber(input.composerTop);
  const viewportTop = Math.max(0, finiteNumber(input.viewportTop));
  const visualHeight = Math.max(1, finiteNumber(input.visualHeight, 1));
  const orientation = input.orientation === "landscape" ? "landscape" : "portrait";
  const keyboardOpen = Boolean(input.keyboardOpen);
  const topMargin = orientation === "landscape" ? 8 : 12;
  const availableAbove = Math.max(0, composerTop - viewportTop - topMargin);
  const preferredCap = orientation === "landscape"
    ? (keyboardOpen ? 220 : 300)
    : (keyboardOpen ? 330 : 430);
  const emergencyCap = Math.max(80, visualHeight - 96);
  return Math.round(clamp(80, availableAbove, Math.min(preferredCap, emergencyCap)));
}

export function deriveMobileComposerMetrics(input = {}) {
  const visualWidth = Math.max(1, finiteNumber(input.visualWidth, 1));
  const visualHeight = Math.max(1, finiteNumber(input.visualHeight, 1));
  const viewportTop = Math.max(0, finiteNumber(input.viewportTop));
  const baselineHeight = Math.max(visualHeight, finiteNumber(input.baselineHeight, visualHeight));
  const orientation = input.orientation === "landscape" || input.orientation === "portrait"
    ? input.orientation
    : getMobileComposerOrientation(visualWidth, visualHeight);
  const active = isMobileComposerViewport({
    width: visualWidth,
    height: visualHeight,
    coarsePointer: input.coarsePointer,
  });
  const keyboardInset = Math.max(0, Math.round(baselineHeight - visualHeight));
  const keyboardOpen = Boolean(
    active
      && input.textareaFocused
      && keyboardInset >= getKeyboardThreshold(baselineHeight)
  );
  const compact = Boolean(
    active
      && keyboardOpen
      && (orientation === "landscape" || visualHeight < 460)
  );

  return Object.freeze({
    active,
    orientation,
    visualWidth: Math.round(visualWidth),
    visualHeight: Math.round(visualHeight),
    viewportTop: Math.round(viewportTop),
    baselineHeight: Math.round(baselineHeight),
    keyboardInset,
    keyboardOpen,
    compact,
    textareaMaxHeight: deriveTextareaMaxHeight({ visualHeight, orientation, keyboardOpen }),
    safeAreaMode: keyboardOpen ? "keyboard" : "safe-area",
  });
}

export function deriveScrollRestore(input = {}) {
  const previousScrollTop = Math.max(0, finiteNumber(input.previousScrollTop));
  const previousScrollHeight = Math.max(0, finiteNumber(input.previousScrollHeight));
  const previousClientHeight = Math.max(0, finiteNumber(input.previousClientHeight));
  const nextScrollHeight = Math.max(0, finiteNumber(input.nextScrollHeight));
  const nextClientHeight = Math.max(0, finiteNumber(input.nextClientHeight));
  const threshold = Math.max(0, finiteNumber(
    input.threshold,
    MOBILE_COMPOSER_SCROLL_ANCHOR_THRESHOLD_PX,
  ));
  const previousBottomDistance = Math.max(
    0,
    previousScrollHeight - previousClientHeight - previousScrollTop,
  );
  const nextMaximum = Math.max(0, nextScrollHeight - nextClientHeight);
  return previousBottomDistance <= threshold
    ? nextMaximum
    : Math.min(previousScrollTop, nextMaximum);
}
