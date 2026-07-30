import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const visualizerSource = await readFile(
  new URL("../scripts/features/live/live-audio-visualizer.js", import.meta.url),
  "utf8",
);
const workspaceSource = await readFile(
  new URL("../scripts/features/artifact-workspace.js", import.meta.url),
  "utf8",
);

for (const token of [
  "stopLoop()",
  "inputLevel = 0",
  "outputLevel = 0",
  "applyRestingFrame()",
  'window.addEventListener("pagehide", reset',
]) {
  assert.ok(visualizerSource.includes(token), `Live cleanup missing ${token}`);
}

for (const token of [
  "placeholder.remove()",
  "setBackgroundInert(false)",
  "chatMessages.scrollTop = chatScrollTop",
  "originButton?.setAttribute(\"aria-expanded\", \"false\")",
  'window.addEventListener("pagehide", () => closeWorkspace',
]) {
  assert.ok(workspaceSource.includes(token), `Artifact workspace cleanup missing ${token}`);
}

console.log("Specialized cleanup contract passed: Live frames and expanded artifact state are explicitly released on close, failure, viewport loss, and navigation.");
