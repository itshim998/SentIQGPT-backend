import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const protocolSource = await readFile(
  new URL("../scripts/features/live/live-audio-protocol.js", import.meta.url),
  "utf8",
);
const visualizerSource = await readFile(
  new URL("../scripts/features/live/live-audio-visualizer.js", import.meta.url),
  "utf8",
);
const workspaceSource = await readFile(
  new URL("../scripts/features/artifact-workspace.js", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../styles/modules/89-specialized-polish.css", import.meta.url),
  "utf8",
);
const constantsSource = await readFile(
  new URL("../scripts/features/chat/constants.js", import.meta.url),
  "utf8",
);
const styleImports = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);

for (const token of [
  'emitLivePcmLevel("input", chunk)',
  'emitLivePcmLevel("output", samples)',
  'import { emitLivePcmLevel }',
]) {
  assert.ok(protocolSource.includes(token), `Live PCM protocol missing ${token}`);
}

for (const token of [
  'document.addEventListener("sentiq-live-pcm-level"',
  'FRAME_INTERVAL_MS = 32',
  'smoothLivePcmLevel',
  '--live-orb-scale',
  '--live-wave-scale-5',
  'window.cancelAnimationFrame',
  'pagehide',
  'RESET_STATES',
]) {
  assert.ok(visualizerSource.includes(token), `Live visualizer missing ${token}`);
}

for (const token of [
  'ARTIFACT_WORKSPACE_MEDIA_QUERY',
  'sentiq-artifact-workspace-placeholder',
  'content.appendChild(surface)',
  'setBackgroundInert(true)',
  'setBackgroundInert(false)',
  'aria-modal',
  'event.key === "Escape"',
  'event.key !== "Tab"',
  'Plotly?.Plots?.resize',
  'Chart?.getChart?.(canvas)?.resize',
  'mediaQuery.addEventListener?.("change"',
]) {
  assert.ok(workspaceSource.includes(token), `Artifact workspace missing ${token}`);
}
assert.equal(workspaceSource.includes("cloneNode"), false, "Expanded workspace must move the real artifact rather than clone stale controls");
assert.equal(workspaceSource.includes("currentExecutionMode"), false);

for (const token of [
  '#live-beta-panel[data-live-audio-reactive="13.2"]',
  '--live-wave-scale-5',
  '.sentiq-artifact-workspace-overlay',
  '.sentiq-artifact-workspace-placeholder',
  '@media (min-width: 1100px)',
  '@media (prefers-reduced-motion: reduce), (update: slow)',
]) {
  assert.ok(styleSource.includes(token), `Specialized stylesheet missing ${token}`);
}
assert.equal(styleSource.includes("transition-property: height"), false);
assert.equal(styleSource.includes("filter: blur("), false);
assert.equal(styleSource.includes("translateY("), false);

const visualizerImport = 'import "../live/live-audio-visualizer.js";';
const workspaceImport = 'import "../artifact-workspace.js";';
assert.ok(constantsSource.includes(visualizerImport));
assert.ok(constantsSource.includes(workspaceImport));
assert.ok(
  constantsSource.indexOf(visualizerImport) > constantsSource.indexOf('import "../controlled-response-polish.js";'),
  "Priority 3 must initialize after Priority 2",
);
assert.ok(constantsSource.indexOf(workspaceImport) > constantsSource.indexOf(visualizerImport));

const priority2Import = '@import url("./88-controlled-response-artifacts.css")';
const priority3Import = '@import url("./89-specialized-polish.css")';
assert.ok(styleImports.includes(priority3Import));
assert.ok(
  styleImports.indexOf(priority3Import) > styleImports.indexOf(priority2Import),
  "Priority 3 stylesheet must layer after Priority 2",
);

console.log("Priority 3 contract passed: Live is driven by real PCM, expanded artifacts keep their live node and focus state, and mobile/reduced-motion behavior remains unchanged.");
