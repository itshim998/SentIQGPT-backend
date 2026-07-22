import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BLUR_HARD_LAYER_LIMITS,
  BLUR_LAYER_BUDGET_VERSION,
  clampBlurLayerLimit,
  deriveBlurLayerBudget,
  selectBlurLayerSlots,
  serializeBlurLayerBudget,
} from "../scripts/features/blur-layer-budget-state.mjs";

assert.equal(BLUR_LAYER_BUDGET_VERSION, "11.3");
assert.deepEqual(BLUR_HARD_LAYER_LIMITS, {
  desktop: 2,
  tablet: 2,
  mobile: 1,
  static: 0,
});
assert.equal(clampBlurLayerLimit(-1), 0);
assert.equal(clampBlurLayerLimit(1.9), 1);
assert.equal(clampBlurLayerLimit(8), 2);

const desktop = deriveBlurLayerBudget({
  width: 1440,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 1,
  backdropSupported: true,
});
assert.equal(desktop.profile, "full");
assert.equal(desktop.viewport, "desktop");
assert.equal(desktop.maxLayers, 2);
assert.equal(desktop.blurPx, 14);
assert.equal(desktop.nestedFullStrengthAllowed, false);

const mobile = deriveBlurLayerBudget({
  width: 430,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
  backdropSupported: true,
});
assert.equal(mobile.profile, "balanced");
assert.equal(mobile.viewport, "mobile");
assert.equal(mobile.maxLayers, 1);
assert.equal(mobile.blurPx, 6);

const constrainedTablet = deriveBlurLayerBudget({
  width: 900,
  deviceMemory: 4,
  hardwareConcurrency: 4,
  devicePixelRatio: 2,
  backdropSupported: true,
});
assert.equal(constrainedTablet.profile, "constrained");
assert.equal(constrainedTablet.viewport, "tablet");
assert.equal(constrainedTablet.maxLayers, 1);
assert.equal(constrainedTablet.blurPx, 6);

for (const capabilities of [
  { width: 1440, backdropSupported: false },
  { width: 1440, backdropSupported: true, saveData: true },
  { width: 1440, backdropSupported: true, reducedTransparency: true },
  { width: 390, backdropSupported: true, mobileGlassProfile: "opaque" },
  { width: 1440, backdropSupported: true, deviceMemory: 2 },
  { width: 1440, backdropSupported: true, hardwareConcurrency: 2 },
]) {
  const state = deriveBlurLayerBudget(capabilities);
  assert.equal(state.profile, "static");
  assert.equal(state.maxLayers, 0);
  assert.equal(state.blurPx, 0);
  assert.equal(state.staticFallback, true);
}

const selected = selectBlurLayerSlots([
  { id: "sidebar", visible: true, nested: false, priority: 70, order: 1 },
  { id: "modal", visible: true, nested: false, priority: 120, order: 2 },
  { id: "menu", visible: true, nested: true, priority: 140, order: 3 },
  { id: "hidden", visible: false, nested: false, priority: 200, order: 4 },
  { id: "composer", visible: true, nested: false, priority: 80, order: 5 },
], 2);
assert.deepEqual(selected, ["modal", "composer"]);
assert.deepEqual(selectBlurLayerSlots([
  { id: "one", visible: true, nested: false, priority: 1, order: 1 },
  { id: "two", visible: true, nested: false, priority: 2, order: 2 },
], 12), ["two", "one"]);
assert.deepEqual(selectBlurLayerSlots([{ id: "one", visible: true, nested: false }], 0), []);
assert.match(serializeBlurLayerBudget(desktop), /^11\.3\|full\|desktop\|2\|14\|112\|filtered$/);

const runtimeSource = await readFile(new URL("../scripts/features/blur-layer-budget.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/75-blur-layer-budget.css", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Blur budget runtime must not own ${forbidden}`);
}

for (const token of [
  'const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)"',
  "document.styleSheets",
  "collectRuleSelectors",
  "ruleUsesBackdrop",
  "KNOWN_BLUR_SELECTORS",
  "NEVER_BLUR_SELECTOR",
  "!element.matches(NEVER_BLUR_SELECTOR)",
  "new MutationObserver",
  'attributeFilter: ["class", "hidden", "open", "style", "aria-hidden", "aria-modal", "data-state"]',
  "selectBlurLayerSlots(candidates, budget.maxLayers)",
  "candidate.element.dataset.sentiqBlurSlot",
  "candidate.element.dataset.sentiqBlurFallback",
  "root.dataset.sentiqBlurMaxLayers",
  "root.dataset.sentiqBlurActiveLayers",
  'new CustomEvent("sentiq-blur-budget-change"',
  'document.addEventListener("sentiq-mobile-glass-budget-change"',
  "window.SentIQBlurLayerBudget = Object.freeze",
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const token of [
  "--sentiq-blur-surface-static",
  "--sentiq-blur-surface-nested",
  "--sentiq-blur-border-elevated",
  '[data-sentiq-blur-candidate="true"]',
  '[data-sentiq-blur-candidate="true"][data-sentiq-blur-slot]',
  "backdrop-filter: blur(var(--sentiq-blur-effective-radius))",
  '[data-sentiq-blur-nested="true"]',
  '[data-sentiq-blur-fallback]',
  '[data-sentiq-blur-slot] [data-sentiq-blur-candidate="true"]',
  ".modal-overlay",
  ".image-lightbox",
  'data-sentiq-blur-profile="static"',
  'data-sentiq-blur-max-layers="0"',
  "min(var(--sentiq-blur-budget-radius), 6px)",
  "min(var(--sentiq-blur-budget-radius), 4px)",
  "@media (prefers-reduced-transparency: reduce), (update: slow)",
  "@supports not ((backdrop-filter: blur(1px))",
  "@media (forced-colors: active)",
]) assert.ok(cssSource.includes(token), `Blur budget CSS missing ${token}`);

assert.ok(cssSource.indexOf("background-color: var(--sentiq-blur-surface-static)") < cssSource.indexOf('[data-sentiq-blur-candidate="true"][data-sentiq-blur-slot]'));
assert.equal(/(^|[;{]\s*)filter\s*:\s*blur\(/m.test(cssSource), false, "Foreground filters must not replace backdrop budgeting");
assert.equal(/animation\s*:/.test(cssSource), false, "Blur budget must not introduce animation");
assert.equal(/transition\s*:/.test(cssSource), false, "Blur budget must not animate blur changes");

const compositorImport = domRefsSource.indexOf('import "../compositor-safety.js";');
const blurRuntimeImport = domRefsSource.indexOf('import "../blur-layer-budget.js";');
const accessibilityRuntimeImport = domRefsSource.indexOf('import "../accessibility-verification.js";');
assert.ok(compositorImport >= 0 && blurRuntimeImport > compositorImport, "Blur budgeting must initialize after compositor safety");
assert.ok(accessibilityRuntimeImport > blurRuntimeImport, "Accessibility verification must audit the final blur-managed surfaces");

const compositorCssImport = importSource.indexOf('@import url("./74-compositor-safety.css");');
const blurCssImport = importSource.indexOf('@import url("./75-blur-layer-budget.css");');
const refinedReducedMotionImport = importSource.indexOf('@import url("./78-refined-reduced-motion.css");');
const accessibilityCssImport = importSource.indexOf('@import url("./79-accessibility-verification.css");');
assert.ok(compositorCssImport >= 0 && blurCssImport > compositorCssImport, "Blur budget must load after compositor safety");
assert.ok(refinedReducedMotionImport > blurCssImport, "Reduced-motion policy must remain able to constrain blur-adjacent motion");
assert.ok(accessibilityCssImport > refinedReducedMotionImport, "Accessibility verification must remain the final policy layer");

console.log("Pass 11.3 blur and layer budget gate passed: two desktop layers, one mobile layer, no nested blur, static capability fallbacks, and later accessibility policies remain ordered.");
