import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeSource = await readFile(
  new URL("../scripts/features/streaming-polish.js", import.meta.url),
  "utf8",
);
const stateSource = await readFile(
  new URL("../scripts/features/streaming-polish-state.mjs", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../styles/modules/87-streaming-polish.css", import.meta.url),
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
  "new MutationObserver",
  "sentiqStreamingPhase",
  "sentiq-streaming-handoff-ghost",
  "response-inline-loader:not(.sentiq-streaming-handoff-ghost)",
  "deriveCompletedProcessSummary",
  "decorateThinkingPanel",
  "insertStandaloneProcessSummary",
  'aria-hidden", "true"',
]) {
  assert.ok(runtimeSource.includes(token), `Streaming polish runtime missing ${token}`);
}

const phaseAssignment = 'content.dataset.sentiqStreamingPhase = "streaming";';
const handoffGuard = "if (state.handoffStarted) return;";
assert.ok(
  runtimeSource.indexOf(phaseAssignment) < runtimeSource.indexOf(handoffGuard),
  "The caret phase must survive observer callbacks from the fading loader clone",
);

assert.equal(runtimeSource.includes("currentExecutionMode"), false);
assert.equal(runtimeSource.includes('=== "fast"'), false);
assert.equal(runtimeSource.includes('=== "intuitive"'), false);
assert.ok(
  constantsSource.includes('import "../streaming-polish.js";'),
  "Streaming polish must initialize once through the shared chat feature graph",
);

for (const token of [
  '.message-content[data-sentiq-streaming-phase="streaming"] > .streaming-tail::after',
  "sentiqStreamingCaretBreathe",
  ".sentiq-streaming-handoff-ghost.is-leaving",
  ".sentiq-completed-process-summary",
  ".sentiq-process-summary-label",
  "@media (prefers-reduced-motion: reduce), (update: slow)",
]) {
  assert.ok(styleSource.includes(token), `Streaming polish stylesheet missing ${token}`);
}
assert.equal(styleSource.includes("transition-property: height"), false);
assert.equal(styleSource.includes("translateY("), false);
assert.equal(styleSource.includes("filter: blur("), false);

const stabilityImport = '@import url("./86-ui-stability.css")';
const polishImport = '@import url("./87-streaming-polish.css")';
assert.ok(styleImports.includes(polishImport), "Streaming polish stylesheet must be loaded");
assert.ok(
  styleImports.indexOf(polishImport) > styleImports.indexOf(stabilityImport),
  "Streaming polish must layer after UI stability without re-enabling streamed-word motion",
);
assert.ok(stateSource.includes("hasSignificantProcessActivity"));
assert.ok(stateSource.includes("Researched"));

console.log("Streaming polish contract passed: one shared pipeline gains a stable caret, loader handoff, and concise completed-process summaries.");
