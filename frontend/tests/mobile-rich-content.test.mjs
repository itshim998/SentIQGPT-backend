import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MOBILE_RICH_CONTENT_VERSION,
  MOBILE_RICH_BREAKPOINT_PX,
  deriveMobileRichLayout,
  isMobileRichViewport,
  serializeMobileRichLayout,
} from "../scripts/features/mobile-rich-content-state.mjs";

assert.equal(MOBILE_RICH_CONTENT_VERSION, "10.5");
assert.equal(MOBILE_RICH_BREAKPOINT_PX, 768);
assert.equal(isMobileRichViewport(768), true);
assert.equal(isMobileRichViewport(769), false);

const narrow = deriveMobileRichLayout({ width: 360, height: 740 });
assert.equal(narrow.widthClass, "narrow");
assert.equal(narrow.heightClass, "standard");
assert.equal(narrow.orientation, "portrait");
assert.equal(narrow.chartMinInlineSize, 440);

const short = deriveMobileRichLayout({ width: 390, height: 520, orientation: "portrait" });
assert.equal(short.heightClass, "short");
assert.equal(short.mediaMaxHeight, 333);

const tall = deriveMobileRichLayout({ width: 430, height: 900, orientation: "portrait" });
assert.equal(tall.heightClass, "tall");
assert.equal(tall.mediaMaxHeight, 620);

const landscape = deriveMobileRichLayout({ width: 740, height: 390, orientation: "landscape" });
assert.equal(landscape.orientation, "landscape");
assert.equal(landscape.heightClass, "short");
assert.equal(landscape.chartMinInlineSize, 600);

const keyboard = deriveMobileRichLayout({ width: 390, height: 430, orientation: "portrait", keyboardOpen: true });
assert.equal(keyboard.keyboardOpen, true);
assert.equal(keyboard.mediaMaxHeight, 189);

const notched = deriveMobileRichLayout({
  width: 390,
  height: 844,
  safeAreaTop: 47,
  safeAreaRight: 0,
  safeAreaBottom: 34,
  safeAreaLeft: 0,
});
assert.equal(notched.safeAreaMode, "notched");
assert.equal(notched.contentInlineSize, 390);
assert.equal(notched.safeAreaBottom, 34);

const desktop = deriveMobileRichLayout({ width: 1280, height: 800, keyboardOpen: true, safeAreaTop: 40 });
assert.equal(desktop.mobile, false);
assert.equal(desktop.widthClass, "desktop");
assert.equal(desktop.keyboardOpen, false);
assert.equal(desktop.safeAreaMode, "flat");
assert.notEqual(serializeMobileRichLayout(desktop), serializeMobileRichLayout(narrow));

const runtimeSource = await readFile(new URL("../scripts/features/mobile-rich-content.js", import.meta.url), "utf8");
const foundationSource = await readFile(new URL("../styles/modules/71-mobile-rich-content.css", import.meta.url), "utf8");
const responsiveSource = await readFile(new URL("../styles/modules/72-mobile-rich-content-responsive.css", import.meta.url), "utf8");
const combinedCss = `${foundationSource}\n${responsiveSource}`;

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval(", "MutationObserver("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Mobile rich-content runtime must not own ${forbidden}`);
}

for (const token of [
  'const MOBILE_QUERY = "(max-width: 768px)"',
  'safeAreaProbe.dataset.mobileRichSafeAreaProbe = "true"',
  'padding-top:env(safe-area-inset-top, 0px)',
  'root.dataset.mobileComposerKeyboard === "open"',
  'document.addEventListener("sentiq-mobile-composer-change"',
  'document.dispatchEvent(new CustomEvent("sentiq-mobile-rich-content-change"',
  'window.SentIQMobileRichContent = Object.freeze',
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const token of [
  '.message-content table',
  '.code-block-wrap pre',
  '.message-content .katex-display',
  '.websurf-v2-featured-card',
  '.image-generation-frame.asset-media-frame',
  '.message-chart-container .message-chart-frame',
  '.generated-file-title',
  '#settings-modal .billing-plan-row',
  '#live-beta-panel .live-beta-transcript',
  'data-mobile-rich-width="narrow"',
  'data-mobile-rich-height="short"',
  'data-mobile-rich-height="tall"',
  'data-mobile-rich-orientation="landscape"',
  'data-mobile-rich-keyboard="open"',
  'data-mobile-rich-safe-area="notched"',
  'overflow-x: auto',
  'overscroll-behavior-inline: contain',
  'env(safe-area-inset-bottom, 0px)',
  'forced-colors: active',
]) assert.ok(combinedCss.includes(token), `Mobile rich-content CSS missing ${token}`);

assert.equal(/animation[^;]*infinite/i.test(combinedCss), false, "Pass 10.5 must not introduce continuous animation");
console.log("Pass 10.5 mobile rich-content phase gate passed: narrow, short, tall, landscape, keyboard-open, and notched layouts.");
