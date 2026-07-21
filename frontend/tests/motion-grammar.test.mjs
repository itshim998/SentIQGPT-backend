import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MOTION_FAMILIES,
  MOTION_GRAMMAR_VERSION,
  createMotionDescriptor,
  deriveMotionPolicy,
  isMotionFamily,
  normalizeMotionFamily,
  normalizeMotionPhase,
} from "../scripts/features/motion-grammar-state.mjs";

assert.equal(MOTION_GRAMMAR_VERSION, "11.1");
assert.deepEqual(MOTION_FAMILIES, [
  "surface",
  "layout",
  "focus",
  "progress",
  "completion",
  "interrupt",
]);
assert.equal(MOTION_FAMILIES.length, 6);
assert.equal(new Set(MOTION_FAMILIES).size, 6);

for (const family of MOTION_FAMILIES) {
  assert.equal(isMotionFamily(family), true);
  assert.equal(normalizeMotionFamily(family.toUpperCase()), family);
}
assert.equal(isMotionFamily("bounce"), false);
assert.equal(normalizeMotionFamily("spring"), "");
assert.equal(normalizeMotionPhase("surface", "exit"), "exit");
assert.equal(normalizeMotionPhase("surface", "unknown"), "enter");
assert.equal(normalizeMotionPhase("layout", "enter"), "");
assert.equal(deriveMotionPolicy(), "full");
assert.equal(deriveMotionPolicy({ prefersReducedMotion: true }), "reduced");
assert.equal(deriveMotionPolicy({ slowUpdate: true }), "reduced");
assert.deepEqual(createMotionDescriptor("surface", { phase: "exit" }), {
  family: "surface",
  phase: "exit",
  policy: "full",
});
assert.equal(createMotionDescriptor("bounce"), null);

const runtimeSource = await readFile(new URL("../scripts/features/motion-grammar.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/73-motion-grammar.css", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval(", "MutationObserver("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Motion grammar runtime must not own ${forbidden}`);
}

for (const token of [
  'const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"',
  'const SLOW_UPDATE_QUERY = "(update: slow)"',
  'root.dataset.sentiqMotionVersion = MOTION_GRAMMAR_VERSION',
  'root.dataset.sentiqMotionPolicy = currentPolicy',
  'document.dispatchEvent(new CustomEvent("sentiq-motion-policy-change"',
  'window.SentIQMotionGrammar = Object.freeze',
  'element.dataset.sentiqMotionFamily = descriptor.family',
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const token of [
  '--sentiq-motion-duration-instant: 80ms',
  '--sentiq-motion-duration-fast: 150ms',
  '--sentiq-motion-duration-standard: 220ms',
  '--sentiq-motion-duration-slow: 320ms',
  '--sentiq-motion-duration-progress: 1600ms',
  '--sentiq-motion-duration-progress-relaxed: 3200ms',
  '--sentiq-motion-ease-standard:',
  '--sentiq-motion-ease-enter:',
  '--sentiq-motion-ease-exit:',
  '--sentiq-motion-ease-linear: linear',
  '--transition: var(--sentiq-motion-focus-duration)',
  '--transition-slow: var(--sentiq-motion-layout-duration)',
]) assert.ok(cssSource.includes(token), `Motion vocabulary missing ${token}`);

for (const familyHeading of [
  "Family 1 — Surface enter and exit",
  "Family 2 — Layout reposition",
  "Family 3 — Focus activation",
  "Family 4 — Progress",
  "Family 5 — Success or completion",
  "Family 6 — Interrupt or error",
]) assert.ok(cssSource.includes(familyHeading), `Missing ${familyHeading}`);

for (const token of [
  'data-sentiq-motion-family="surface"',
  'data-sentiq-motion-family="layout"',
  'data-sentiq-motion-family="focus"',
  'data-sentiq-motion-family="progress"',
  'data-sentiq-motion-family="completion"',
  'data-sentiq-motion-family="interrupt"',
  ".message.user",
  ".adaptive-panel-surface:not(#account-panel)",
  ".websurf-v2-featured-card",
  ".app-container",
  '.sidebar[data-mobile-navigation-version="10.1"]',
  ".thinking-content",
  ':where(\n  button,',
  ".message-action-btn",
  ".semantic-activity-progress .response-inline-spinner::after",
  ".conversation-attention-marker",
  ".failure-recovery-panel",
  'data-sentiq-motion-policy="reduced"] *::before',
  '@media (prefers-reduced-motion: reduce), (update: slow)',
]) assert.ok(cssSource.includes(token), `Motion family coverage missing ${token}`);

assert.equal(cssSource.includes(":is(\n  .response-inline-spinner,\n  .chat-cache-spinner,\n  .semantic-activity-mark::after"), false, "Pseudo-elements must not be nested inside :is()");
assert.equal((cssSource.match(/\binfinite\b/g) || []).length, 1, "Only the explicit progress family may repeat indefinitely");
assert.ok(cssSource.includes('data-sentiq-motion-family="progress"] {\n  animation: sentiqMotionProgressSpin'));

const richRuntimeImport = domRefsSource.indexOf('import "../mobile-rich-content.js";');
const motionRuntimeImport = domRefsSource.indexOf('import "../motion-grammar.js";');
assert.ok(richRuntimeImport >= 0 && motionRuntimeImport > richRuntimeImport, "Motion grammar runtime must load after the completed mobile foundation");

const richCssImport = importSource.indexOf('@import url("./72-mobile-rich-content-responsive.css");');
const motionCssImport = importSource.indexOf('@import url("./73-motion-grammar.css");');
const reducedMotionRule = importSource.indexOf("@media (prefers-reduced-motion: reduce)");
assert.ok(richCssImport >= 0 && motionCssImport > richCssImport, "Motion grammar CSS must be the final component layer");
assert.ok(reducedMotionRule > motionCssImport, "The global reduced-motion guard must remain after the grammar");

console.log("Pass 11.1 motion grammar gate passed: six families, one vocabulary, reduced-motion and slow-update safeguards.");
