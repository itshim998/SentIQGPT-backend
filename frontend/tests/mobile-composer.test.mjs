import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MOBILE_COMPOSER_VERSION,
  MOBILE_COMPOSER_BREAKPOINT_PX,
  MOBILE_COMPOSER_KEYBOARD_MIN_INSET_PX,
  deriveActionMenuMaxHeight,
  deriveMobileComposerMetrics,
  deriveScrollRestore,
  deriveTextareaMaxHeight,
  getMobileComposerOrientation,
  isMobileComposerViewport,
} from "../scripts/features/mobile-composer-state.mjs";

assert.equal(MOBILE_COMPOSER_VERSION, "10.2");
assert.equal(MOBILE_COMPOSER_BREAKPOINT_PX, 768);
assert.equal(MOBILE_COMPOSER_KEYBOARD_MIN_INSET_PX, 72);
assert.equal(getMobileComposerOrientation(390, 844), "portrait");
assert.equal(getMobileComposerOrientation(844, 390), "landscape");
assert.equal(isMobileComposerViewport({ width: 768, height: 800 }), true);
assert.equal(isMobileComposerViewport({ width: 769, height: 800 }), false);
assert.equal(isMobileComposerViewport({ width: 844, height: 390, coarsePointer: true }), true, "phone landscape remains mobile-adaptive");
assert.equal(isMobileComposerViewport({ width: 1024, height: 700, coarsePointer: true }), false);

const closedPortrait = deriveMobileComposerMetrics({
  visualWidth: 390,
  visualHeight: 844,
  baselineHeight: 844,
  textareaFocused: true,
  coarsePointer: true,
});
assert.equal(closedPortrait.active, true);
assert.equal(closedPortrait.keyboardOpen, false);
assert.equal(closedPortrait.safeAreaMode, "safe-area");
assert.equal(closedPortrait.textareaMaxHeight, 168);

const openPortrait = deriveMobileComposerMetrics({
  visualWidth: 390,
  visualHeight: 450,
  baselineHeight: 844,
  textareaFocused: true,
  coarsePointer: true,
});
assert.equal(openPortrait.keyboardOpen, true);
assert.equal(openPortrait.compact, true);
assert.equal(openPortrait.safeAreaMode, "keyboard");
assert.equal(openPortrait.textareaMaxHeight, 108);

const openLandscape = deriveMobileComposerMetrics({
  visualWidth: 844,
  visualHeight: 250,
  baselineHeight: 390,
  textareaFocused: true,
  coarsePointer: true,
});
assert.equal(openLandscape.active, true);
assert.equal(openLandscape.orientation, "landscape");
assert.equal(openLandscape.keyboardOpen, true);
assert.equal(openLandscape.textareaMaxHeight, 60);
assert.ok(deriveTextareaMaxHeight({ visualHeight: 250, orientation: "landscape", keyboardOpen: true }) <= 88);

assert.equal(deriveActionMenuMaxHeight({
  composerTop: 360,
  viewportTop: 0,
  visualHeight: 450,
  orientation: "portrait",
  keyboardOpen: true,
}), 330);
assert.equal(deriveActionMenuMaxHeight({
  composerTop: 140,
  viewportTop: 0,
  visualHeight: 250,
  orientation: "landscape",
  keyboardOpen: true,
}), 132);

assert.equal(deriveScrollRestore({
  previousScrollTop: 900,
  previousScrollHeight: 1500,
  previousClientHeight: 550,
  nextScrollHeight: 1500,
  nextClientHeight: 300,
}), 1200, "near-bottom conversations remain bottom-anchored");
assert.equal(deriveScrollRestore({
  previousScrollTop: 400,
  previousScrollHeight: 1500,
  previousClientHeight: 550,
  nextScrollHeight: 1500,
  nextClientHeight: 300,
}), 400, "reading position is preserved away from the bottom");

const runtimeSource = await readFile(new URL("../scripts/features/mobile-composer.js", import.meta.url), "utf8");
const modelSource = await readFile(new URL("../scripts/features/mobile-composer-state.mjs", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const foundationSource = await readFile(new URL("../styles/modules/65-mobile-composer.css", import.meta.url), "utf8");
const responsiveSource = await readFile(new URL("../styles/modules/66-mobile-composer-responsive.css", import.meta.url), "utf8");
const combinedCss = `${foundationSource}\n${responsiveSource}`;

for (const forbidden of ["document.", "window.", "localStorage", "sessionStorage", "fetch("]) {
  assert.equal(modelSource.includes(forbidden), false, `Pure mobile composer model must not own ${forbidden}`);
}
for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "window.scrollTo(", "body.style.position", "scrollIntoView("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Mobile composer must avoid unstable or unrelated ownership: ${forbidden}`);
}

for (const token of [
  'window.visualViewport?.addEventListener?.("resize", handleViewportChange',
  'window.visualViewport?.addEventListener?.("scroll", handleViewportChange',
  'focusScrollSnapshot = captureScrollSnapshot()',
  'restoreScrollSnapshot(scrollSnapshot)',
  'chatMessages.scrollTop = nextScrollTop',
  'setRootProperty("--mobile-composer-viewport-height"',
  'setRootProperty("--mobile-composer-keyboard-inset"',
  'setRootProperty("--mobile-composer-textarea-max-height"',
  'setRootProperty("--mobile-composer-action-menu-max-height"',
  'chatInput.style.height = "auto"',
  'chatInput.style.overflowY = overflowing ? "auto" : "hidden"',
  'new ResizeObserver(() => schedule("resize-observer"))',
  'new MutationObserver(() => schedule("menu-state"))',
  'window.SentIQMobileComposer = Object.freeze',
]) assert.ok(runtimeSource.includes(token), `Mobile composer runtime missing ${token}`);

assert.ok(
  domRefsSource.indexOf('import "../mobile-navigation.js";')
    < domRefsSource.indexOf('import "../mobile-composer.js";'),
  "Mobile composer must initialize after mobile navigation",
);
assert.ok(importsSource.includes('@import url("./65-mobile-composer.css");'));
assert.ok(importsSource.includes('@import url("./66-mobile-composer-responsive.css");'));

for (const token of [
  ':root[data-mobile-composer-version="10.2"]',
  ':root[data-mobile-composer-active="true"] .app-container',
  'height: var(--mobile-composer-viewport-height)',
  'top: var(--mobile-composer-viewport-top)',
  '--mobile-composer-bottom-padding: max(12px, env(safe-area-inset-bottom, 0px))',
  ':root[data-mobile-composer-keyboard="open"]',
  '--mobile-composer-bottom-padding: 8px',
  'max-height: var(--mobile-composer-textarea-max-height)',
  'data-mobile-composer-textarea-overflow="true"',
  'var(--mobile-composer-action-menu-max-height)',
  'data-mobile-composer-orientation="landscape"',
  'data-mobile-composer-compact="true"',
  'overscroll-behavior: contain',
  'prefers-reduced-motion: reduce',
  'forced-colors: active',
]) assert.ok(combinedCss.includes(token), `Mobile composer CSS missing ${token}`);

assert.equal(
  /padding-bottom\s*:\s*calc\([^;]*env\(safe-area-inset-bottom/i.test(combinedCss),
  false,
  "Safe-area padding must replace the base gap rather than being added twice",
);
assert.equal(/animation[^;]*infinite/i.test(combinedCss), false, "Pass 10.2 must not introduce continuous composer animation");

console.log("Pass 10.2 mobile composer and keyboard phase gate passed.");
