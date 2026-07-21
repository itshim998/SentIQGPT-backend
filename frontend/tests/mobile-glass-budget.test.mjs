import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MOBILE_GLASS_BUDGET_VERSION,
  MOBILE_GLASS_BREAKPOINT_PX,
  deriveMobileGlassBudget,
  isMobileGlassViewport,
  serializeMobileGlassBudget,
} from "../scripts/features/mobile-glass-budget-state.mjs";

assert.equal(MOBILE_GLASS_BUDGET_VERSION, "10.4");
assert.equal(MOBILE_GLASS_BREAKPOINT_PX, 768);
assert.equal(isMobileGlassViewport(768), true);
assert.equal(isMobileGlassViewport(769), false);

const desktop = deriveMobileGlassBudget({
  width: 1280,
  deviceMemory: 2,
  hardwareConcurrency: 2,
  saveData: true,
  backdropSupported: false,
});
assert.equal(desktop.profile, "desktop");
assert.equal(desktop.atmosphere, "full");
assert.equal(desktop.overlayBackdropFiltering, true);

const balanced = deriveMobileGlassBudget({
  width: 430,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
  backdropSupported: true,
});
assert.equal(balanced.profile, "balanced");
assert.equal(balanced.blurPx, 8);
assert.equal(balanced.atmosphere, "frozen");
assert.equal(balanced.overlayBackdropFiltering, false);
assert.ok(balanced.simultaneousGlassLayers <= 2);

const constrained = deriveMobileGlassBudget({
  width: 390,
  deviceMemory: 4,
  hardwareConcurrency: 4,
  devicePixelRatio: 3,
  backdropSupported: true,
});
assert.equal(constrained.profile, "constrained");
assert.equal(constrained.blurPx, 4);
assert.equal(constrained.atmosphere, "simplified");
assert.equal(constrained.simultaneousGlassLayers, 1);

for (const input of [
  { width: 430, backdropSupported: false },
  { width: 430, saveData: true },
  { width: 430, deviceMemory: 2, backdropSupported: true },
  { width: 430, hardwareConcurrency: 2, backdropSupported: true },
]) {
  const state = deriveMobileGlassBudget(input);
  assert.equal(state.profile, "opaque");
  assert.equal(state.blurPx, 0);
  assert.equal(state.atmosphere, "static");
  assert.equal(state.opaqueFallback, true);
  assert.equal(state.overlayBackdropFiltering, false);
}

assert.notEqual(serializeMobileGlassBudget(desktop), serializeMobileGlassBudget(balanced));
assert.equal(serializeMobileGlassBudget(balanced), serializeMobileGlassBudget({ ...balanced }));

const runtimeSource = await readFile(new URL("../scripts/features/mobile-glass-budget.js", import.meta.url), "utf8");
const foundationSource = await readFile(new URL("../styles/modules/69-mobile-glass-budget.css", import.meta.url), "utf8");
const responsiveSource = await readFile(new URL("../styles/modules/70-mobile-glass-budget-responsive.css", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const combinedCss = `${foundationSource}\n${responsiveSource}`;

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval(", "MutationObserver("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Mobile glass runtime must not own ${forbidden}`);
}

for (const token of [
  'const MOBILE_QUERY = "(max-width: 768px)"',
  'window.CSS.supports("backdrop-filter", "blur(1px)")',
  'deviceMemory: navigator.deviceMemory',
  'hardwareConcurrency: navigator.hardwareConcurrency',
  'saveData: Boolean(connection?.saveData)',
  'connection?.addEventListener?.("change"',
  'window.visualViewport?.addEventListener?.("resize"',
  'root.style.setProperty("--sentiq-mobile-glass-blur"',
  'root.classList.toggle("mobile-glass-budget-active"',
  'applyState(currentState, "initial")',
  'document.dispatchEvent(new CustomEvent("sentiq-mobile-glass-budget-change"',
  'window.SentIQMobileGlassBudget = Object.freeze',
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const token of [
  '--sentiq-mobile-glass-blur: 8px',
  'animation: none !important',
  '.sidebar-backdrop',
  'body.has-websurf-source-sheet::before',
  'backdrop-filter: none !important',
  'data-mobile-glass-budget-profile="constrained"',
  'data-mobile-glass-budget-profile="opaque"',
  '@supports not ((backdrop-filter: blur(1px))',
  'background-color: #0b0e15',
  'forced-colors: active',
]) assert.ok(combinedCss.includes(token), `Mobile glass CSS missing ${token}`);

assert.equal(/body::before[^}]*animation:\s*sentiqAmbientDrift/is.test(combinedCss), false);
assert.equal(/sidebar-backdrop[^}]*backdrop-filter:\s*blur/is.test(combinedCss), false);
assert.equal(/modal-overlay[^}]*backdrop-filter:\s*blur/is.test(combinedCss), false);
assert.equal(combinedCss.includes('min(4px, var(--sentiq-mobile-glass-blur))'), false);
assert.equal(combinedCss.includes(':is(\n    body::before'), false);

const touchImport = domRefsSource.indexOf('import "../touch-interaction-language.js";');
const glassImport = domRefsSource.indexOf('import "../mobile-glass-budget.js";');
assert.ok(touchImport >= 0 && glassImport > touchImport, "Mobile glass runtime must load after touch interaction");

const touchCssImport = importSource.indexOf('@import url("./68-touch-overflow-responsive.css");');
const glassCssImport = importSource.indexOf('@import url("./69-mobile-glass-budget.css");');
const glassResponsiveImport = importSource.indexOf('@import url("./70-mobile-glass-budget-responsive.css");');
assert.ok(touchCssImport >= 0 && glassCssImport > touchCssImport && glassResponsiveImport > glassCssImport);

console.log("Pass 10.4 mobile density and glass budget phase gate passed.");
