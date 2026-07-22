import assert from "node:assert/strict";
import {
  ACCESSIBILITY_MIN_TOUCH_TARGET,
  contrastRatio,
  nextRovingIndex,
} from "../scripts/features/accessibility-verification-state.mjs";
import {
  BLUR_MOBILE_BREAKPOINT_PX,
  deriveBlurLayerBudget,
} from "../scripts/features/blur-layer-budget-state.mjs";
import {
  MOBILE_COMPOSER_BREAKPOINT_PX,
  deriveMobileComposerMetrics,
  deriveScrollRestore,
} from "../scripts/features/mobile-composer-state.mjs";
import {
  MOBILE_GLASS_BREAKPOINT_PX,
  deriveMobileGlassBudget,
} from "../scripts/features/mobile-glass-budget-state.mjs";
import {
  MOBILE_NAVIGATION_BREAKPOINT_PX,
  deriveMobileNavigationState,
} from "../scripts/features/mobile-navigation-state.mjs";
import { deriveMotionPolicy } from "../scripts/features/motion-grammar-state.mjs";

assert.equal(MOBILE_NAVIGATION_BREAKPOINT_PX, 768);
assert.equal(MOBILE_COMPOSER_BREAKPOINT_PX, MOBILE_NAVIGATION_BREAKPOINT_PX);
assert.equal(MOBILE_GLASS_BREAKPOINT_PX, MOBILE_NAVIGATION_BREAKPOINT_PX);
assert.equal(BLUR_MOBILE_BREAKPOINT_PX, MOBILE_NAVIGATION_BREAKPOINT_PX);
assert.equal(ACCESSIBILITY_MIN_TOUCH_TARGET, 44);

const openNavigation = deriveMobileNavigationState({ mobile: true, open: true });
assert.deepEqual(openNavigation, {
  mobile: true,
  open: true,
  sidebarHidden: false,
  pageInert: true,
  scrollLocked: true,
  sheetRole: "dialog",
  ariaModal: "true",
  toggleExpanded: "true",
});
const desktopNavigation = deriveMobileNavigationState({ mobile: false, open: true });
assert.equal(desktopNavigation.open, false);
assert.equal(desktopNavigation.pageInert, false);
assert.equal(desktopNavigation.ariaModal, "false");

const keyboardComposer = deriveMobileComposerMetrics({
  visualWidth: 390,
  visualHeight: 360,
  baselineHeight: 760,
  viewportTop: 0,
  coarsePointer: true,
  textareaFocused: true,
});
assert.equal(keyboardComposer.active, true);
assert.equal(keyboardComposer.orientation, "landscape");
assert.equal(keyboardComposer.keyboardOpen, true);
assert.equal(keyboardComposer.compact, true);
assert.ok(keyboardComposer.textareaMaxHeight >= 60 && keyboardComposer.textareaMaxHeight <= 88);
assert.equal(keyboardComposer.safeAreaMode, "keyboard");

assert.equal(deriveScrollRestore({
  previousScrollTop: 480,
  previousScrollHeight: 1000,
  previousClientHeight: 500,
  nextScrollHeight: 1400,
  nextClientHeight: 500,
}), 900, "Near-bottom conversations should remain anchored to the newest content");
assert.equal(deriveScrollRestore({
  previousScrollTop: 100,
  previousScrollHeight: 1000,
  previousClientHeight: 500,
  nextScrollHeight: 1400,
  nextClientHeight: 500,
}), 100, "Reading position should remain stable when the user is away from the bottom");

const weakGlass = deriveMobileGlassBudget({
  width: 390,
  deviceMemory: 2,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
  backdropSupported: true,
});
const weakBlur = deriveBlurLayerBudget({
  width: 390,
  deviceMemory: 2,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
  backdropSupported: true,
});
assert.equal(weakGlass.profile, "opaque");
assert.equal(weakGlass.opaqueFallback, true);
assert.equal(weakBlur.profile, "static");
assert.equal(weakBlur.maxLayers, 0);
assert.equal(weakBlur.blurPx, 0);

const balancedGlass = deriveMobileGlassBudget({
  width: 430,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
});
const balancedBlur = deriveBlurLayerBudget({
  width: 430,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
});
assert.equal(balancedGlass.profile, "balanced");
assert.equal(balancedGlass.simultaneousGlassLayers, 2);
assert.equal(balancedBlur.viewport, "mobile");
assert.equal(balancedBlur.maxLayers, 1, "The later global blur budget must cap mobile filtering to one surface");
assert.equal(balancedBlur.nestedFullStrengthAllowed, false);

assert.equal(deriveMotionPolicy({ prefersReducedMotion: true }), "reduced");
const reducedBlur = deriveBlurLayerBudget({
  width: 1024,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 1,
  reducedMotion: true,
});
assert.equal(reducedBlur.profile, "constrained");
assert.equal(reducedBlur.maxLayers, 1);

assert.equal(nextRovingIndex({ currentIndex: 2, itemCount: 4, key: "ArrowRight", orientation: "horizontal" }), 3);
assert.equal(nextRovingIndex({ currentIndex: 3, itemCount: 4, key: "ArrowRight", orientation: "horizontal" }), 0);
assert.equal(nextRovingIndex({ currentIndex: 2, itemCount: 4, key: "ArrowDown", orientation: "horizontal" }), 2);
assert.ok(contrastRatio("#f0f2f7", "#06070b") >= 4.5);

console.log("Pass 12.2 UI-state invariants passed: responsive breakpoints, focus containment state, keyboard composition, scroll anchoring, motion, blur, touch, and contrast remain aligned.");
