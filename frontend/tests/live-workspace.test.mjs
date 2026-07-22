import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const liveSurface = await readFile(new URL("../scripts/features/live-surface.js", import.meta.url), "utf8");
const panelLifecycle = await readFile(new URL("../scripts/features/panel-focus-recovery.js", import.meta.url), "utf8");
const liveController = await readFile(new URL("../scripts/features/live/live-controller.js", import.meta.url), "utf8");
const adaptivePanels = await readFile(new URL("../scripts/features/adaptive-panel-framework.js", import.meta.url), "utf8");
const domRefs = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const imports = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const foundation = await readFile(new URL("../styles/modules/51-live-workspace.css", import.meta.url), "utf8");
const responsive = await readFile(new URL("../styles/modules/52-live-workspace-responsive.css", import.meta.url), "utf8");
const entryControl = await readFile(new URL("../styles/modules/53-live-entry-control.css", import.meta.url), "utf8");

for (const token of [
  'LIVE_SURFACE_VERSION = "8.4"',
  "live-workspace-voice-object",
  "Live voice controls",
  "live-workspace-transcript-sheet",
  "live-beta-transcript-close",
  "Continue in chat",
  "LIVE_FAILURE_STATES",
  "LIVE_RETRYABLE_STATES",
  "setTranscriptBackgroundInert",
  'toggleAttribute("inert", !open)',
  "stopImmediatePropagation",
  "queueMicrotask",
  "sentiq-panel-closed",
  "SentIQPanels?.sync?.()",
]) assert.ok(liveSurface.includes(token), `Live surface missing ${token}`);

for (const forbidden of ["fetch(", "localStorage", "sessionStorage", "SentIQAPI", "getUserMedia", "WebSocket("]) {
  assert.equal(liveSurface.includes(forbidden), false, `Live presentation must not own ${forbidden}`);
}

for (const token of [
  'PANEL_LIFECYCLE_VERSION = "8.4"',
  "triggerByPanel",
  "sentiq-panel-opened",
  "sentiq-panel-closed",
  "previousTrigger",
  "activePanelId",
  "SentIQPanels?.sync?.()",
  "adaptive-panel-open",
  "adaptive-panel-modal-open",
  "sentiq-panel-stack-restored",
]) assert.ok(panelLifecycle.includes(token), `Panel lifecycle gate missing ${token}`);

for (const token of [
  "restoreBackground",
  "inerted.clear()",
  "updateBackgroundState",
  "previousFocus",
  "restoreTarget?.isConnected",
]) assert.ok(adaptivePanels.includes(token), `Adaptive panel background/focus contract missing ${token}`);

for (const token of [
  'setPanelState("connecting"',
  'setPanelState("listening"',
  'setPanelState("speaking"',
  'muted ? "muted" : "listening"',
  'setAttribute("aria-pressed", muted ? "true" : "false")',
  'setAttribute("aria-expanded", transcriptWrap.open ? "true" : "false")',
  "finishSession(\"client_end\")",
]) assert.ok(liveController.includes(token), `Live controller state/control contract missing ${token}`);

assert.ok(domRefs.includes('import "../panel-focus-recovery.js";'));
assert.ok(domRefs.includes('import "../live-surface.js";'));
assert.ok(
  domRefs.indexOf('import "../live-surface.js";') < domRefs.indexOf('import "../adaptive-panel-framework.js";'),
  "Transcript Escape handling must register before the parent panel Escape trap",
);
assert.ok(imports.includes('@import url("./51-live-workspace.css");'));
assert.ok(imports.includes('@import url("./52-live-workspace-responsive.css");'));
assert.ok(imports.includes('@import url("./53-live-entry-control.css");'));

for (const token of [
  "live-workspace-surface",
  "live-workspace-voice-object",
  "live-workspace-connection",
  "live-workspace-controls",
  "live-workspace-transcript-host[open]",
  "live-workspace-fallback-actions",
  "data-state=\"listening\"",
  "data-state=\"speaking\"",
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) assert.ok(foundation.includes(token), `Live workspace CSS missing ${token}`);

for (const token of [
  "min-width: 641px",
  "max-width: 640px",
  "height: 100dvh",
  "safe-area-inset-bottom",
  "max-height: 660px",
  "orientation: landscape",
  "prefers-reduced-motion: reduce",
]) assert.ok(responsive.includes(token), `Responsive Live CSS missing ${token}`);

for (const token of [
  ".btn-live-voice",
  ".btn-live-voice::after",
  ".btn-live-voice.is-disabled",
  "box-shadow: none",
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) assert.ok(entryControl.includes(token), `Live entry control CSS missing ${token}`);

assert.equal(foundation.includes("0 0 90px"), false, "Live voice object must avoid excessive glow");
assert.equal(foundation.includes("backdrop-filter: blur(30px)"), false, "Live panel atmosphere must remain restrained");
assert.equal(entryControl.includes("radial-gradient"), false, "Live entry control must avoid neon atmosphere");

console.log("Pass 8.4 SentIQ Live phase gate passed.");
