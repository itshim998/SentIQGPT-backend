import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeSource = await readFile(
  new URL("../scripts/features/controlled-response-polish.js", import.meta.url),
  "utf8",
);
const stateSource = await readFile(
  new URL("../scripts/features/controlled-response-polish-state.mjs", import.meta.url),
  "utf8",
);
const generatedFileSource = await readFile(
  new URL("../scripts/features/generated-file-result-presentation.js", import.meta.url),
  "utf8",
);
const imageSource = await readFile(
  new URL("../scripts/features/image-result-presentation.js", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../styles/modules/88-controlled-response-artifacts.css", import.meta.url),
  "utf8",
);
const styleImports = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);
const constantsSource = await readFile(
  new URL("../scripts/features/chat/constants.js", import.meta.url),
  "utf8",
);

for (const token of [
  "seenBlockKeys",
  "buildRevealBlockKey",
  "sentiq-block-reveal",
  "sentiq-block-settled",
  "animationend",
  "BLOCK_REVEAL_FALLBACK_MS",
  "sentiq-chart-wireframe",
  "new MutationObserver",
]) {
  assert.ok(runtimeSource.includes(token), `Controlled response runtime missing ${token}`);
}
assert.equal(runtimeSource.includes("currentExecutionMode"), false);
assert.equal(runtimeSource.includes('=== "fast"'), false);
assert.equal(runtimeSource.includes('=== "intuitive"'), false);

for (const token of [
  "htmlBatchStates",
  "sentiq-batched-html-code",
  "sentiq-batched-html-preview",
  "sentiq-html-code-source",
  "sentiq-html-preview-source",
  "sourceCode.remove()",
  "sourcePreview.remove()",
  'resolveArtifactBatchDelay("code")',
  'resolveArtifactBatchDelay("preview")',
  'attributeFilter: ["srcdoc"]',
  "flushCode(true)",
  "flushPreview(true)",
]) {
  assert.ok(generatedFileSource.includes(token), `Generated-file batching missing ${token}`);
}
for (const token of [
  "asset-file-wireframe is-document",
  "asset-file-wireframe is-sheet",
  "asset-file-wireframe is-html",
  "asset-sheet-wire-grid",
  "asset-document-wire-page",
]) {
  assert.ok(generatedFileSource.includes(token), `Typed file wireframe missing ${token}`);
}

for (const token of [
  "resolveReservedMediaAspect",
  "--sentiq-media-aspect",
  "sentiqReservedMedia",
  'image.setAttribute("width"',
  'image.setAttribute("height"',
]) {
  assert.ok(imageSource.includes(token), `Image geometry reservation missing ${token}`);
}

for (const token of [
  "@keyframes sentiqBlockOpacityReveal",
  ".sentiq-block-reveal",
  "aspect-ratio: var(--sentiq-media-aspect, 4 / 3)",
  "aspect-ratio: 16 / 9",
  ".sentiq-chart-wireframe",
  ".asset-file-wireframe.is-document",
  ".asset-file-wireframe.is-sheet",
  ".asset-file-wireframe.is-html",
  ".sentiq-batched-html-preview",
  "contain: layout paint",
  "@media (prefers-reduced-motion: reduce), (update: slow)",
]) {
  assert.ok(styleSource.includes(token), `Priority 2 stylesheet missing ${token}`);
}
assert.equal(styleSource.includes("translateY("), false);
assert.equal(styleSource.includes("filter: blur("), false);
assert.equal(styleSource.includes("transition-property: height"), false);
assert.ok(stateSource.includes("HTML_PREVIEW_BATCH_INTERVAL_MS"));
assert.ok(stateSource.includes("resolveReservedMediaAspect"));

const priorityOneImport = '@import url("./87-streaming-polish.css")';
const priorityTwoImport = '@import url("./88-controlled-response-artifacts.css")';
assert.ok(styleImports.includes(priorityTwoImport), "Priority 2 stylesheet must be loaded");
assert.ok(
  styleImports.indexOf(priorityTwoImport) > styleImports.indexOf(priorityOneImport),
  "Priority 2 must layer after streaming stability and caret polish",
);
assert.ok(
  constantsSource.indexOf('import "../controlled-response-polish.js";')
    > constantsSource.indexOf('import "../streaming-polish.js";'),
  "Priority 2 must initialize once after the shared Priority 1 pipeline",
);

console.log("Controlled response contract passed: blocks reveal once, HTML surfaces batch visibly, typed wireframes reserve artifact space, and Fast/Intuitive remain unified.");
