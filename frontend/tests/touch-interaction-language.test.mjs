import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  TOUCH_INTERACTION_VERSION,
  TOUCH_MENU_RELEASE_FRAMES,
  TOUCH_PRESS_CANCEL_DISTANCE_PX,
  TOUCH_TARGET_MIN_PX,
  deriveTouchTargetContract,
  getPointerTravel,
  isEligibleTouchTarget,
  isTouchLikePointer,
  shouldCancelPressedFeedback,
} from "../scripts/features/touch-interaction-state.mjs";

assert.equal(TOUCH_INTERACTION_VERSION, "10.3");
assert.equal(TOUCH_TARGET_MIN_PX, 44);
assert.equal(TOUCH_PRESS_CANCEL_DISTANCE_PX, 10);
assert.equal(TOUCH_MENU_RELEASE_FRAMES, 2);
assert.equal(isTouchLikePointer("touch"), true);
assert.equal(isTouchLikePointer("pen"), true);
assert.equal(isTouchLikePointer("mouse"), false);
assert.equal(isTouchLikePointer("mouse", true), true);
assert.equal(getPointerTravel(0, 0, 6, 8), 10);
assert.equal(shouldCancelPressedFeedback({ startX: 0, startY: 0, currentX: 6, currentY: 8 }), false);
assert.equal(shouldCancelPressedFeedback({ startX: 0, startY: 0, currentX: 7, currentY: 8 }), true);
assert.equal(shouldCancelPressedFeedback({ pointerCancelled: true }), true);
assert.equal(isEligibleTouchTarget({ connected: true, visible: true }), true);
assert.equal(isEligibleTouchTarget({ disabled: true }), false);
assert.equal(isEligibleTouchTarget({ ariaDisabled: true }), false);
assert.deepEqual(deriveTouchTargetContract({ compact: false }), {
  minimumSize: 44,
  mode: "minimum-box",
  pressedFeedback: "direct",
});
assert.deepEqual(deriveTouchTargetContract({ compact: true, ariaDisabled: true }), {
  minimumSize: 44,
  mode: "expanded-hitbox",
  pressedFeedback: "none",
});

const runtimeSource = await readFile(new URL("../scripts/features/touch-interaction-language.js", import.meta.url), "utf8");
const foundationSource = await readFile(new URL("../styles/modules/67-touch-interaction-language.css", import.meta.url), "utf8");
const responsiveSource = await readFile(new URL("../styles/modules/68-touch-overflow-responsive.css", import.meta.url), "utf8");
const combinedCss = `${foundationSource}\n${responsiveSource}`;

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "window.scrollTo(", "scrollIntoView("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Touch interaction runtime must not own ${forbidden}`);
}

for (const token of [
  'const TOUCH_QUERY = "(hover: none), (pointer: coarse)"',
  'element.dataset.touchTarget = "true"',
  'element.dataset.touchHitbox = "expanded"',
  'chrome.dataset.touchDragDiscoverable = "dismiss"',
  'eyebrow.textContent = "Swipe down to close"',
  'menu.dataset.touchMenuUnderFinger = "true"',
  'releaseMenuAfterFinger(current.menu, current.menuTrigger)',
  'element.classList.add("is-touch-pressed")',
  'shouldCancelPressedFeedback({',
  'new MutationObserver((records)',
  'window.SentIQTouchInteraction = Object.freeze',
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const token of [
  '--sentiq-touch-target-min: 44px',
  '[data-touch-hitbox="minimum-box"]',
  '[data-touch-hitbox="expanded"]::after',
  'inline-size: max(100%, var(--sentiq-touch-target-min))',
  '[data-touch-menu-under-finger="true"]',
  '.is-touch-pressed',
  '.message-action-bar',
  '.asset-image-overlay',
  'overflow-wrap: anywhere',
  '.websurf-v2-citation-chip-label',
  'min-height: 44px',
  'min-width: 44px',
  'overflow-x: hidden',
  'prefers-reduced-motion: reduce',
  'forced-colors: active',
]) assert.ok(combinedCss.includes(token), `Touch CSS missing ${token}`);

assert.equal(/animation[^;]*infinite/i.test(combinedCss), false, "Pass 10.3 must not introduce continuous touch animation");
console.log("Pass 10.3 touch interaction language phase gate passed.");
