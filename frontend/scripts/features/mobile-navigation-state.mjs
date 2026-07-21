/* SentIQ Chat — Phase 10.1 mobile navigation state model */

export const MOBILE_NAVIGATION_VERSION = "10.1";
export const MOBILE_NAVIGATION_BREAKPOINT_PX = 768;
export const MOBILE_NAVIGATION_CLOSE_DISTANCE_PX = 72;
export const MOBILE_NAVIGATION_CLOSE_VELOCITY_PX_MS = 0.42;
export const MOBILE_NAVIGATION_MAX_DRAG_PX = 180;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function isMobileNavigationViewport(width) {
  return finiteNumber(width, Number.POSITIVE_INFINITY) <= MOBILE_NAVIGATION_BREAKPOINT_PX;
}

export function clampMobileNavigationDrag(deltaY) {
  const distance = Math.max(0, finiteNumber(deltaY));
  if (distance <= 0) return 0;
  const softened = distance <= 96
    ? distance
    : 96 + ((distance - 96) * 0.34);
  return Math.min(MOBILE_NAVIGATION_MAX_DRAG_PX, Math.round(softened));
}

export function shouldCloseMobileNavigationGesture(input = {}) {
  const deltaY = Math.max(0, finiteNumber(input.deltaY));
  const deltaX = Math.abs(finiteNumber(input.deltaX));
  const durationMs = Math.max(1, finiteNumber(input.durationMs, 1));
  const velocity = deltaY / durationMs;
  const isVertical = deltaY > deltaX * 1.15;
  return Boolean(
    isVertical
      && (
        deltaY >= MOBILE_NAVIGATION_CLOSE_DISTANCE_PX
        || (deltaY >= 34 && velocity >= MOBILE_NAVIGATION_CLOSE_VELOCITY_PX_MS)
      )
  );
}

export function deriveMobileNavigationState(input = {}) {
  const mobile = Boolean(input.mobile);
  const open = mobile && Boolean(input.open);
  return Object.freeze({
    mobile,
    open,
    sidebarHidden: mobile && !open,
    pageInert: open,
    scrollLocked: open,
    sheetRole: mobile ? "dialog" : "",
    ariaModal: open ? "true" : "false",
    toggleExpanded: open ? "true" : "false",
  });
}
