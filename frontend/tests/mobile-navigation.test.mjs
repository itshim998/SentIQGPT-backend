import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MOBILE_NAVIGATION_VERSION,
  MOBILE_NAVIGATION_BREAKPOINT_PX,
  MOBILE_NAVIGATION_CLOSE_DISTANCE_PX,
  clampMobileNavigationDrag,
  deriveMobileNavigationState,
  isMobileNavigationViewport,
  shouldCloseMobileNavigationGesture,
} from "../scripts/features/mobile-navigation-state.mjs";

assert.equal(MOBILE_NAVIGATION_VERSION, "10.1");
assert.equal(MOBILE_NAVIGATION_BREAKPOINT_PX, 768);
assert.equal(MOBILE_NAVIGATION_CLOSE_DISTANCE_PX, 72);
assert.equal(isMobileNavigationViewport(320), true);
assert.equal(isMobileNavigationViewport(768), true);
assert.equal(isMobileNavigationViewport(769), false);
assert.equal(isMobileNavigationViewport(undefined), false);

assert.equal(clampMobileNavigationDrag(-20), 0);
assert.equal(clampMobileNavigationDrag(48), 48);
assert.ok(clampMobileNavigationDrag(240) <= 180);
assert.ok(clampMobileNavigationDrag(160) < 160, "long drags must gain resistance");

assert.equal(shouldCloseMobileNavigationGesture({ deltaY: 78, deltaX: 12, durationMs: 480 }), true);
assert.equal(shouldCloseMobileNavigationGesture({ deltaY: 40, deltaX: 5, durationMs: 70 }), true, "a deliberate fast downward flick closes");
assert.equal(shouldCloseMobileNavigationGesture({ deltaY: 60, deltaX: 56, durationMs: 120 }), false, "diagonal gestures must not close the sheet");
assert.equal(shouldCloseMobileNavigationGesture({ deltaY: 44, deltaX: 8, durationMs: 500 }), false, "short slow drags settle back");
assert.equal(shouldCloseMobileNavigationGesture({ deltaY: -90, deltaX: 0, durationMs: 100 }), false, "upward movement does not close");

assert.deepEqual(deriveMobileNavigationState({ mobile: false, open: true }), {
  mobile: false,
  open: false,
  sidebarHidden: false,
  pageInert: false,
  scrollLocked: false,
  sheetRole: "",
  ariaModal: "false",
  toggleExpanded: "false",
});
assert.deepEqual(deriveMobileNavigationState({ mobile: true, open: false }), {
  mobile: true,
  open: false,
  sidebarHidden: true,
  pageInert: false,
  scrollLocked: false,
  sheetRole: "dialog",
  ariaModal: "false",
  toggleExpanded: "false",
});
assert.deepEqual(deriveMobileNavigationState({ mobile: true, open: true }), {
  mobile: true,
  open: true,
  sidebarHidden: false,
  pageInert: true,
  scrollLocked: true,
  sheetRole: "dialog",
  ariaModal: "true",
  toggleExpanded: "true",
});

const runtimeSource = await readFile(new URL("../scripts/features/mobile-navigation.js", import.meta.url), "utf8");
const modelSource = await readFile(new URL("../scripts/features/mobile-navigation-state.mjs", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/63-mobile-navigation.css", import.meta.url), "utf8");
const responsiveSource = await readFile(new URL("../styles/modules/64-mobile-navigation-responsive.css", import.meta.url), "utf8");
const combinedCss = `${cssSource}\n${responsiveSource}`;

for (const forbidden of ["document.", "window.", "localStorage", "sessionStorage", "fetch("]) {
  assert.equal(modelSource.includes(forbidden), false, `Pure mobile navigation model must not own ${forbidden}`);
}
for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "Notification", "navigator.vibrate", "body.style.position = \"fixed\"", "body.style.touchAction = \"none\""]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Mobile navigation must avoid unstable or unrelated ownership: ${forbidden}`);
}

for (const token of [
  'const MOBILE_QUERY = "(max-width: 768px)"',
  'className = "mobile-navigation-sheet-chrome"',
  'class="mobile-navigation-sheet-grip"',
  'class="mobile-navigation-close"',
  'aria-label="Close navigation"',
  'requestClose({ restoreFocus: true, source: "close-button" })',
  'requestClose({ restoreFocus: true, source: "swipe-down" })',
  'requestClose({ restoreFocus: true, source: "escape" })',
  'sidebar.setAttribute("role", "dialog")',
  'sidebar.setAttribute("aria-modal", state.ariaModal)',
  'sidebar.setAttribute("aria-hidden", state.sidebarHidden ? "true" : "false")',
  'element.setAttribute("inert", "")',
  'element.setAttribute("aria-hidden", "true")',
  'lockUnderlyingScroll()',
  'unlockUnderlyingScroll()',
  'chatScrollTop: chatMessages?.scrollTop || 0',
  'if (chatMessages) chatMessages.scrollTop = snapshot.chatScrollTop',
  'document.addEventListener("touchmove", handleOutsideTouchMove, { passive: false })',
  'document.addEventListener("keydown", handleKeydown, { capture: true })',
  'window.visualViewport?.addEventListener?.("resize", updateViewportHeight',
  'new MutationObserver((records) =>',
  'window.SentIQMobileNavigation = Object.freeze',
]) assert.ok(runtimeSource.includes(token), `Mobile navigation runtime missing ${token}`);

assert.ok(
  domRefsSource.indexOf('import "../attention-management.js";')
    < domRefsSource.indexOf('import "../mobile-navigation.js";'),
  "Mobile navigation must initialize after shared continuity and attention state",
);
assert.ok(importsSource.includes('@import url("./63-mobile-navigation.css");'));
assert.ok(importsSource.includes('@import url("./64-mobile-navigation-responsive.css");'));

for (const token of [
  '@media (max-width: 768px)',
  ':root[data-mobile-navigation-version="10.1"]',
  '.sidebar[data-mobile-navigation-version="10.1"]',
  'inset: auto 0 0 0',
  'transform: translate3d(0, calc(100% + 32px), 0)',
  'transform: translate3d(0, var(--mobile-navigation-drag-y, 0px), 0)',
  '.mobile-navigation-sheet-chrome',
  '.mobile-navigation-sheet-grip',
  '.mobile-navigation-close',
  'env(safe-area-inset-top)',
  'env(safe-area-inset-bottom)',
  '.sidebar[data-mobile-navigation-version="10.1"] .sidebar-conversations',
  'overscroll-behavior: contain',
  '.sidebar[data-mobile-navigation-version="10.1"] .sidebar-footer',
  'margin-top: auto',
  '.sidebar-backdrop',
  'body.mobile-navigation-open .main-content',
  'prefers-reduced-motion: reduce',
  'forced-colors: active',
]) assert.ok(combinedCss.includes(token), `Mobile navigation CSS missing ${token}`);

assert.equal(combinedCss.includes("translateX(-100%)"), false, "Pass 10.1 must not recreate the old mobile off-canvas geometry");
assert.equal(/animation[^;]*infinite/i.test(combinedCss), false, "The mobile sheet must not animate continuously");

console.log("Pass 10.1 mobile navigation phase gate passed.");
