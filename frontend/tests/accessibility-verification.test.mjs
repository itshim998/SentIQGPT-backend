import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ACCESSIBILITY_MIN_LARGE_TEXT_CONTRAST,
  ACCESSIBILITY_MIN_TEXT_CONTRAST,
  ACCESSIBILITY_MIN_TOUCH_TARGET,
  ACCESSIBILITY_VERIFICATION_VERSION,
  contrastRatio,
  isRovingNavigationKey,
  meetsContrast,
  nextRovingIndex,
  normalizeHexColor,
} from "../scripts/features/accessibility-verification-state.mjs";

const runtime = await readFile(new URL("../scripts/features/accessibility-verification.js", import.meta.url), "utf8");
const css = await readFile(new URL("../styles/modules/79-accessibility-verification.css", import.meta.url), "utf8");
const imports = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const domRefs = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const adaptivePanels = await readFile(new URL("../scripts/features/adaptive-panel-framework.js", import.meta.url), "utf8");
const mobileNavigation = await readFile(new URL("../scripts/features/mobile-navigation.js", import.meta.url), "utf8");
const reducedMotion = await readFile(new URL("../styles/modules/78-refined-reduced-motion.css", import.meta.url), "utf8");
const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

function balancedBraces(source) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      if (char === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      comment = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && !quote && !comment;
}

assert.equal(ACCESSIBILITY_VERIFICATION_VERSION, "12.1");
assert.equal(ACCESSIBILITY_MIN_TOUCH_TARGET, 44);
assert.equal(ACCESSIBILITY_MIN_TEXT_CONTRAST, 4.5);
assert.equal(ACCESSIBILITY_MIN_LARGE_TEXT_CONTRAST, 3);
assert.equal(normalizeHexColor("#fff"), "#ffffff");
assert.equal(normalizeHexColor("invalid"), "");
assert.ok(contrastRatio("#f0f2f7", "#06070b") > 7, "Primary text must exceed enhanced contrast on the canonical canvas");
assert.ok(meetsContrast("#aab1bf", "#06070b"), "Secondary text must meet ordinary text contrast");
assert.ok(meetsContrast("#737b8b", "#06070b"), "Muted text fallback must meet 4.5:1 on the canonical canvas");
assert.equal(meetsContrast("#777777", "#888888"), false);

for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]) {
  assert.equal(isRovingNavigationKey(key), true);
}
assert.equal(isRovingNavigationKey("Tab"), false);
assert.equal(nextRovingIndex({ currentIndex: 0, itemCount: 4, key: "ArrowDown", orientation: "vertical" }), 1);
assert.equal(nextRovingIndex({ currentIndex: 0, itemCount: 4, key: "ArrowUp", orientation: "vertical" }), 3);
assert.equal(nextRovingIndex({ currentIndex: 2, itemCount: 4, key: "Home" }), 0);
assert.equal(nextRovingIndex({ currentIndex: 1, itemCount: 4, key: "End" }), 3);
assert.equal(nextRovingIndex({ currentIndex: 1, itemCount: 4, key: "ArrowLeft", orientation: "vertical" }), 1);

assert.ok(balancedBraces(css), "Pass 12.1 CSS must have balanced blocks");
assert.ok(balancedBraces(runtime), "Pass 12.1 runtime must have balanced blocks");

for (const token of [
  "sentiq-skip-link",
  "Skip to main content",
  'setAttributeIfChanged(chatMessages, "role", "log")',
  'setAttributeIfChanged(composerMenu, "role", "menu")',
  'setAttributeIfChanged(composerTrigger, "aria-haspopup", "menu")',
  'setAttributeIfChanged(executionToggle, "aria-haspopup", "listbox")',
  "handleRovingContainerKey",
  "handleTabListKey",
  'event.key === "Escape"',
  'document.addEventListener("focusin"',
  "activeModalDialog",
  "focusDialog",
  "sentiq-a11y-announcer",
  'setAttributeIfChanged(alert, "role", "alert")',
  'setAttributeIfChanged(host, "aria-busy", "true")',
  "positiveTabIndex",
  "window.SentIQAccessibility = Object.freeze",
]) assert.ok(runtime.includes(token), `Accessibility runtime missing ${token}`);

assert.equal(runtime.includes("setInterval("), false);
assert.equal(runtime.includes("fetch("), false);
assert.equal(runtime.includes("localStorage"), false);
assert.ok(runtime.includes('.observe(document.body, { childList: true, subtree: true })'), "Dynamic enhancement observer must stay bounded to inserted nodes");
assert.equal(runtime.includes("attributes: true"), false, "Accessibility observer must not rescan on every ARIA attribute update");

for (const token of [
  ":focus-visible",
  "outline: 2px solid var(--sentiq-a11y-focus) !important",
  "--sentiq-a11y-touch-target: 44px",
  "@media (hover: none), (pointer: coarse)",
  "@media (max-width: 900px)",
  "At 200% browser zoom",
  "@media (max-width: 520px), (max-height: 520px)",
  "overflow-wrap: anywhere",
  "overscroll-behavior-inline: contain",
  "@media (prefers-contrast: more)",
  "@media (prefers-reduced-motion: reduce), (update: slow)",
  "@media (forced-colors: active)",
  "outline: 3px solid Highlight !important",
]) assert.ok(css.includes(token), `Accessibility CSS missing ${token}`);

assert.ok(adaptivePanels.includes('entry.surface.setAttribute("aria-modal", "true")'));
assert.ok(adaptivePanels.includes("inertAround(activeModal.root)"));
assert.ok(adaptivePanels.includes('event.key === "Escape"'));
assert.ok(adaptivePanels.includes('event.key !== "Tab" || !entry.modal'));
assert.ok(adaptivePanels.includes("restoreTarget.focus({ preventScroll: true })"));
assert.ok(mobileNavigation.includes('setAttr(sidebar, "aria-modal", state.ariaModal)'));
assert.ok(mobileNavigation.includes("setUnderlyingPageInert(true)"));
assert.ok(mobileNavigation.includes('event.key === "Escape"'));
assert.ok(mobileNavigation.includes('event.key !== "Tab" || !isOpen()'));
assert.ok(mobileNavigation.includes("sidebarToggle.focus({ preventScroll: true })"));

assert.ok(index.includes('id="chat-messages" class="chat-messages" aria-live="polite"'));
assert.ok(index.includes('role="status" aria-live="polite"'));
assert.ok(index.includes('role="dialog" aria-modal="true"'));
assert.ok(index.includes('aria-label="Mute microphone"'));
assert.ok(index.includes('aria-label="Close Live voice"') || index.includes('aria-label="End Live voice"'));
assert.ok(index.includes('name="viewport" content="width=device-width, initial-scale=1.0'));
assert.equal(index.includes("maximum-scale=1"), false, "Zoom must not be disabled");
assert.equal(index.includes("user-scalable=no"), false, "Pinch zoom must remain available");

const reducedImport = imports.indexOf('@import url("./78-refined-reduced-motion.css");');
const accessibilityImport = imports.indexOf('@import url("./79-accessibility-verification.css");');
assert.ok(reducedImport >= 0 && accessibilityImport > reducedImport, "Accessibility verification CSS must load after reduced-motion and decorative layers");
const blurRuntime = domRefs.indexOf('import "../blur-layer-budget.js";');
const accessibilityRuntime = domRefs.indexOf('import "../accessibility-verification.js";');
assert.ok(blurRuntime >= 0 && accessibilityRuntime > blurRuntime, "Accessibility verification runtime must load after panel, mobile, and motion foundations");

assert.ok(reducedMotion.includes("scroll-behavior: auto !important"));
assert.ok(reducedMotion.includes("Static loader equivalents"));
assert.ok(reducedMotion.includes("Live voice remains state-readable"));

console.log("Pass 12.1 accessibility gate passed: keyboard, focus, traps, Escape, names, live regions, contrast, touch, motion, zoom, and dense content are covered.");
