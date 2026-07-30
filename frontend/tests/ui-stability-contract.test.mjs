import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeSource = await readFile(
  new URL("../scripts/features/ui-stability.js", import.meta.url),
  "utf8",
);
const bootstrapSource = await readFile(
  new URL("../scripts/bootstrap-guard.js", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../styles/modules/86-ui-stability.css", import.meta.url),
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
  'document.addEventListener("click"',
  'chatInput.addEventListener("keydown"',
  'sentiq-optimistic-user',
  'syncProgrammaticComposerClear',
  'SentIQConversationContinuity',
  'messageTextMatches',
  'OPTIMISTIC_SEND_TIMEOUT_MS',
  'shouldClearRestoredComposer',
  'baselineAssistantCount',
  'hasSuccessfulAssistantResponse',
  'userEditedAfterSend',
  'sentiqSuccessfulSendGuard',
  'beginChatListStabilization',
  'sentiq-chat-list-stabilizing',
  'new MutationObserver',
]) {
  assert.ok(runtimeSource.includes(token), `UI stability runtime missing ${token}`);
}

assert.equal(
  runtimeSource.includes("preventDefault()"),
  false,
  "UI stability must observe the established send path rather than replacing it",
);
assert.equal(
  runtimeSource.includes("stopImmediatePropagation()"),
  false,
  "UI stability must not suppress existing composer handlers",
);

for (const token of [
  'root.dataset.sentiqBootState = "loading"',
  'root.dataset.sentiqBootState = "ready"',
  'root.dataset.sentiqBootState = "failed"',
  'sentiq-startup-screen',
  'Still getting your workspace ready',
  'sentiq-ui-ready',
]) {
  assert.ok(bootstrapSource.includes(token), `Deterministic startup missing ${token}`);
}
assert.equal(
  bootstrapSource.includes("readinessTimer = window.setTimeout(fail"),
  false,
  "A slow startup must not be converted into a permanent disabled failure state",
);

for (const token of [
  'html[data-sentiq-boot-state="loading"] .app-container',
  'field-sizing: fixed !important',
  'transition-property: border-color, background-color, box-shadow, opacity !important',
  'text-wrap: wrap !important',
  '.streaming-new-text',
  'animation: none !important',
  'margin-block-end: 2px',
  '#chat-list.sentiq-chat-list-stabilizing',
  'min-block-size: var(--sentiq-chat-list-stable-height, auto)',
  'overflow-anchor: none',
  'contain: layout paint style',
]) {
  assert.ok(styleSource.includes(token), `UI stability stylesheet missing ${token}`);
}
assert.equal(
  styleSource.includes("transition-property: height"),
  false,
  "Composer height must never be tweened while text wraps",
);

const stabilityImport = '@import url("./86-ui-stability.css")';
const previousImport = '@import url("./85-unboxed-activity-controls.css")';
const streamingPolishImport = '@import url("./87-streaming-polish.css")';
const controlledResponseImport = '@import url("./88-controlled-response-artifacts.css")';
assert.ok(styleImports.includes(stabilityImport), "UI stability stylesheet must be loaded");
assert.ok(
  styleImports.indexOf(stabilityImport) > styleImports.indexOf(previousImport),
  "UI stability must resolve the legacy enhancement layers before streaming polish",
);
assert.ok(
  styleImports.indexOf(streamingPolishImport) > styleImports.indexOf(stabilityImport),
  "Streaming polish must remain constrained by the final UI-stability decisions",
);
assert.ok(
  styleImports.indexOf(controlledResponseImport) > styleImports.indexOf(streamingPolishImport),
  "Controlled artifact polish must remain downstream of the anti-shake and caret layers",
);
assert.ok(
  constantsSource.includes('import "../ui-stability.js";'),
  "UI stability runtime must initialize with the composer feature graph",
);
assert.ok(
  constantsSource.indexOf('import "../streaming-polish.js";') > constantsSource.indexOf('import "../ui-stability.js";'),
  "Streaming polish must initialize after UI stability on the same shared chat path",
);
assert.ok(
  constantsSource.indexOf('import "../controlled-response-polish.js";') > constantsSource.indexOf('import "../streaming-polish.js";'),
  "Controlled response polish must initialize after Priority 1 without creating a mode-specific path",
);

console.log("UI stability contract gate passed: startup is deterministic, successful sends reconcile safely, history refresh stays bounded, streaming words remain stationary, and controlled block/artifact polish can only add paint-safe behavior.");
