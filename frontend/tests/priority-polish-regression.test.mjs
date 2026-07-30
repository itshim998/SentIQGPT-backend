import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  stability,
  priority1Runtime,
  priority1Style,
  priority2Runtime,
  priority2Style,
  priority3Live,
  priority3Workspace,
  priority3Style,
  constants,
  imports,
] = await Promise.all([
  read("../styles/modules/86-ui-stability.css"),
  read("../scripts/features/streaming-polish.js"),
  read("../styles/modules/87-streaming-polish.css"),
  read("../scripts/features/controlled-response-polish.js"),
  read("../styles/modules/88-controlled-response-artifacts.css"),
  read("../scripts/features/live/live-audio-visualizer.js"),
  read("../scripts/features/artifact-workspace.js"),
  read("../styles/modules/89-specialized-polish.css"),
  read("../scripts/features/chat/constants.js"),
  read("../styles/modules/12-reduced-motion.css"),
]);

assert.ok(stability.includes("text-wrap: wrap !important"));
assert.ok(stability.includes(".streaming-new-text"));
assert.ok(stability.includes("animation: none !important"));
assert.ok(priority1Runtime.includes("sentiq-streaming-handoff-ghost"));
assert.ok(priority1Style.includes("sentiqStreamingCaretBreathe"));
assert.ok(priority2Runtime.includes("if (block.classList.contains(\"sentiq-block-reveal\")) return"));
assert.ok(priority2Style.includes("sentiqBlockOpacityReveal"));
assert.ok(priority2Style.includes("data-sentiq-artifact-batch=\"13.1\""));
assert.ok(priority3Live.includes("sentiq-live-pcm-level"));
assert.ok(priority3Workspace.includes("content.appendChild(surface)"));
assert.ok(priority3Style.includes("sentiq-artifact-workspace-overlay"));

for (const source of [priority1Runtime, priority2Runtime, priority3Live, priority3Workspace]) {
  assert.equal(source.includes('=== "fast"'), false, "Polish layers must not fork Fast rendering");
  assert.equal(source.includes('=== "intuitive"'), false, "Polish layers must not fork Intuitive rendering");
  assert.equal(source.includes("currentExecutionMode"), false, "Polish layers must remain mode-neutral");
}

for (const source of [priority1Style, priority2Style, priority3Style]) {
  assert.equal(source.includes("transition-property: height"), false, "Polish must never animate layout height");
  assert.equal(source.includes("filter: blur("), false, "Polish must not reintroduce streamed-content blur");
}

assert.ok(priority1Style.includes("@media (prefers-reduced-motion: reduce), (update: slow)"));
assert.ok(priority2Style.includes("@media (prefers-reduced-motion: reduce), (update: slow)"));
assert.ok(priority3Style.includes("@media (prefers-reduced-motion: reduce), (update: slow)"));
assert.ok(priority3Workspace.includes("setBackgroundInert(true)"));
assert.ok(priority3Workspace.includes("setBackgroundInert(false)"));
assert.ok(priority3Workspace.includes("placeholder.remove()"));
assert.ok(priority3Live.includes("window.cancelAnimationFrame"));

const runtimeOrder = [
  'import "../ui-stability.js";',
  'import "../streaming-polish.js";',
  'import "../controlled-response-polish.js";',
  'import "../live/live-audio-visualizer.js";',
  'import "../artifact-workspace.js";',
].map((token) => constants.indexOf(token));
assert.ok(runtimeOrder.every((index) => index >= 0));
assert.deepEqual([...runtimeOrder].sort((a, b) => a - b), runtimeOrder, "Priority runtime order must be deterministic");

const styleOrder = [
  '@import url("./86-ui-stability.css")',
  '@import url("./87-streaming-polish.css")',
  '@import url("./88-controlled-response-artifacts.css")',
  '@import url("./89-specialized-polish.css")',
].map((token) => imports.indexOf(token));
assert.ok(styleOrder.every((index) => index >= 0));
assert.deepEqual([...styleOrder].sort((a, b) => a - b), styleOrder, "Priority stylesheet order must be deterministic");

console.log("Priority 1–3 regression gate passed: stable text remains authoritative, each enhancement layers once, expensive artifact work stays bounded, Live cleanup is explicit, and no execution-mode fork was introduced.");
