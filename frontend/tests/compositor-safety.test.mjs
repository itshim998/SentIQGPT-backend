import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COMPOSITOR_FORBIDDEN_CONTINUOUS_PROPERTIES,
  COMPOSITOR_SAFE_PROPERTIES,
  COMPOSITOR_SAFETY_VERSION,
  clampUnitInterval,
  deriveCompositorPolicy,
  normalizeCompositorProperties,
  toCompositorProgressScale,
} from "../scripts/features/compositor-safety-state.mjs";

assert.equal(COMPOSITOR_SAFETY_VERSION, "11.2");
assert.deepEqual(COMPOSITOR_SAFE_PROPERTIES, ["transform", "opacity"]);
assert.equal(new Set(COMPOSITOR_SAFE_PROPERTIES).size, 2);
for (const property of [
  "width",
  "height",
  "max-height",
  "box-shadow",
  "filter",
  "backdrop-filter",
  "background-position",
  "background-size",
]) assert.ok(COMPOSITOR_FORBIDDEN_CONTINUOUS_PROPERTIES.includes(property));

assert.equal(clampUnitInterval(-2), 0);
assert.equal(clampUnitInterval(0.45), 0.45);
assert.equal(clampUnitInterval(9), 1);
assert.equal(clampUnitInterval("invalid"), 0);
assert.equal(toCompositorProgressScale(-20), 0);
assert.equal(toCompositorProgressScale(45), 0.45);
assert.equal(toCompositorProgressScale(140), 1);
assert.deepEqual(normalizeCompositorProperties("opacity, width, transform, opacity"), ["opacity", "transform"]);
assert.deepEqual(normalizeCompositorProperties(["filter", "transform"]), ["transform"]);
assert.equal(deriveCompositorPolicy(), "full");
assert.equal(deriveCompositorPolicy({ prefersReducedMotion: true }), "reduced");
assert.equal(deriveCompositorPolicy({ slowUpdate: true }), "reduced");
assert.equal(deriveCompositorPolicy({ saveData: true }), "reduced");

const runtimeSource = await readFile(new URL("../scripts/features/compositor-safety.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/74-compositor-safety.css", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const progressSource = await readFile(new URL("../scripts/features/deep-research-progress-workspace.js", import.meta.url), "utf8");
const workspaceSource = await readFile(new URL("../scripts/features/deep-research-workspace.js", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("../styles/modules/02-layout-sidebar.css", import.meta.url), "utf8");
const messageSource = await readFile(new URL("../styles/modules/03-chat-messages.css", import.meta.url), "utf8");
const richSource = await readFile(new URL("../styles/modules/05-rich-responses.css", import.meta.url), "utf8");
const loaderSource = await readFile(new URL("../styles/modules/06-loaders.css", import.meta.url), "utf8");
const composerSource = await readFile(new URL("../styles/modules/07-composer.css", import.meta.url), "utf8");
const atmosphereSource = await readFile(new URL("../styles/modules/13-premium-refinement.css", import.meta.url), "utf8");
const researchSource = await readFile(new URL("../styles/modules/15-deep-research.css", import.meta.url), "utf8");
const liveSource = await readFile(new URL("../styles/modules/16-live-beta.css", import.meta.url), "utf8");
const researchWorkspaceSource = await readFile(new URL("../styles/modules/36-deep-research-workspace.css", import.meta.url), "utf8");

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval(", "MutationObserver("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Compositor runtime must not own ${forbidden}`);
}

for (const token of [
  'const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"',
  'const SLOW_UPDATE_QUERY = "(update: slow)"',
  "connection?.saveData",
  "root.dataset.sentiqCompositorVersion = COMPOSITOR_SAFETY_VERSION",
  "root.dataset.sentiqCompositorPolicy = currentPolicy",
  'new CustomEvent("sentiq-compositor-policy-change"',
  'element.style.setProperty("--sentiq-progress-scale", String(scale))',
  "window.SentIQCompositorSafety = Object.freeze",
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const token of [
  "@property --deep-research-progress-scale",
  '--sentiq-compositor-safe-properties: transform, opacity',
  "@keyframes sentiqCompositorSweep",
  "@keyframes sentiqCompositorTextEnter",
  "@keyframes sentiqCompositorOpacityPulse",
  "@keyframes sentiqCompositorLiveWave",
  ':root[data-sentiq-motion-version="11.1"] :is(',
  ':root[data-sentiq-motion-version="11.1"] .thinking-content',
  ':root[data-sentiq-motion-version="11.1"] .sentiq-loader',
  "transition-property: transform, opacity",
  "body::before",
  "animation: none",
  ".sentiq-loader::before",
  "animation-name: sentiqCompositorSweep",
  ".image-skeleton::after",
  "contain: paint",
  '.deep-research-card[data-deep-research-workspace-version="7.2"] .deep-research-progress-fill',
  "transform: scaleX(var(--deep-research-progress-scale, 0))",
  ".live-beta-wave i",
  "transform: scaleY(0.32)",
  'data-sentiq-compositor-policy="reduced"',
  "@media (prefers-reduced-motion: reduce), (update: slow)",
]) assert.ok(cssSource.includes(token), `Compositor layer missing ${token}`);

function extractKeyframeBodies(source) {
  const bodies = [];
  const marker = /@keyframes\s+[\w-]+\s*\{/g;
  let match;
  while ((match = marker.exec(source))) {
    let depth = 1;
    let index = marker.lastIndex;
    const start = index;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      index += 1;
    }
    bodies.push(source.slice(start, index - 1));
    marker.lastIndex = index;
  }
  return bodies;
}

const keyframeBodies = extractKeyframeBodies(cssSource);
assert.equal(keyframeBodies.length, 4);
for (const body of keyframeBodies) {
  for (const property of COMPOSITOR_FORBIDDEN_CONTINUOUS_PROPERTIES) {
    const propertyPattern = new RegExp(`(^|[;{]\\s*)${property.replace("-", "\\-")}\\s*:`, "m");
    assert.equal(propertyPattern.test(body), false, `Keyframes must not animate ${property}`);
  }
}

const transitionPropertyDeclarations = [...cssSource.matchAll(/transition-property\s*:\s*([^;]+);/g)].map((match) => match[1]);
assert.ok(transitionPropertyDeclarations.length >= 8);
for (const declaration of transitionPropertyDeclarations) {
  for (const property of COMPOSITOR_FORBIDDEN_CONTINUOUS_PROPERTIES) {
    assert.equal(new RegExp(`(^|,\\s*)${property}(\\s*,|$)`).test(declaration), false, `Transition list must not include ${property}`);
  }
}
assert.equal(/transition\s*:\s*all\b/.test(cssSource), false);
assert.equal(/:is\([^)]*::(?:before|after)/s.test(cssSource), false, "Pseudo-elements must not be nested inside :is()");
assert.equal((cssSource.match(/\binfinite\b/g) || []).length, 1, "Only the bounded skeleton progress sweep may repeat in this layer");

assert.ok(sidebarSource.includes("width var(--transition-slow)"));
assert.ok(cssSource.includes("@media (min-width: 769px)"));
assert.ok(messageSource.includes("max-height var(--transition-slow)"));
assert.ok(cssSource.includes('.thinking-panel[data-expanded="true"] .thinking-content'));
assert.ok(loaderSource.includes("background-position: 220% 0"));
assert.ok(cssSource.includes("background-attachment: scroll"));
assert.ok(composerSource.includes("background-position: 100% 50%"));
assert.ok(cssSource.includes("animation-name: sentiqCompositorOpacityPulse"));
assert.ok(atmosphereSource.includes("animation: sentiqAmbientDrift"));
assert.ok(richSource.includes("animation: shimmer"));
assert.ok(researchSource.includes("transition: width"));
assert.ok(researchWorkspaceSource.includes("transition: width"));
assert.ok(liveSource.includes("50% { height: 31px"));

assert.ok(progressSource.includes('import { toCompositorProgressScale } from "./compositor-safety-state.mjs"'));
assert.ok(progressSource.includes('fill.style.setProperty("--deep-research-progress-scale", scaleValue)'));
assert.equal(/fill\.style\.width\s*=/.test(progressSource), false);
assert.ok(workspaceSource.includes('getPropertyValue("--deep-research-progress-scale")'));
assert.ok(workspaceSource.includes('getPropertyValue("--deep-research-progress")'));

const motionRuntimeImport = domRefsSource.indexOf('import "../motion-grammar.js";');
const compositorRuntimeImport = domRefsSource.indexOf('import "../compositor-safety.js";');
assert.ok(motionRuntimeImport >= 0 && compositorRuntimeImport > motionRuntimeImport, "Compositor policy must load after the motion grammar");

const motionCssImport = importSource.indexOf('@import url("./73-motion-grammar.css");');
const compositorCssImport = importSource.indexOf('@import url("./74-compositor-safety.css");');
const reducedMotionRule = importSource.indexOf("@media (prefers-reduced-motion: reduce)");
assert.ok(motionCssImport >= 0 && compositorCssImport > motionCssImport, "Compositor safety must be the final component layer");
assert.ok(reducedMotionRule > compositorCssImport, "The global reduced-motion guard must remain last");

console.log("Pass 11.2 compositor safety gate passed: transform/opacity motion, bounded progress, paint-heavy overrides, cascade precedence, and reduced policies.");
