/* SentIQ Chat — Pass 10.3 touch interaction state helpers */

export const TOUCH_INTERACTION_VERSION = "10.3";
export const TOUCH_TARGET_MIN_PX = 44;
export const TOUCH_PRESS_CANCEL_DISTANCE_PX = 10;
export const TOUCH_MENU_RELEASE_FRAMES = 2;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function isTouchLikePointer(pointerType, coarsePointer = false) {
  const type = String(pointerType || "").toLowerCase();
  return Boolean(coarsePointer || type === "touch" || type === "pen");
}

export function getPointerTravel(startX, startY, currentX, currentY) {
  const deltaX = finiteNumber(currentX) - finiteNumber(startX);
  const deltaY = finiteNumber(currentY) - finiteNumber(startY);
  return Math.hypot(deltaX, deltaY);
}

export function shouldCancelPressedFeedback(input = {}) {
  if (input.pointerCancelled) return true;
  return getPointerTravel(
    input.startX,
    input.startY,
    input.currentX,
    input.currentY,
  ) > Math.max(0, finiteNumber(input.cancelDistance, TOUCH_PRESS_CANCEL_DISTANCE_PX));
}

export function isEligibleTouchTarget(input = {}) {
  return Boolean(
    input.connected !== false
      && input.visible !== false
      && !input.disabled
      && !input.ariaDisabled
  );
}

export function deriveTouchTargetContract(input = {}) {
  const compact = Boolean(input.compact);
  return Object.freeze({
    minimumSize: TOUCH_TARGET_MIN_PX,
    mode: compact ? "expanded-hitbox" : "minimum-box",
    pressedFeedback: input.disabled || input.ariaDisabled ? "none" : "direct",
  });
}
