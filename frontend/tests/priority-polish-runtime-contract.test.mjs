import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeSource = await readFile(
  new URL("../../scripts/testPriorityPolishRuntime.mjs", import.meta.url),
  "utf8",
);
const workflowSource = await readFile(
  new URL("../../.github/workflows/frontend-checks.yml", import.meta.url),
  "utf8",
);

for (const token of [
  "firstRevealStarted",
  "replacementDidNotReplay",
  "caretActive",
  "listeningDirection",
  "speakingDirection",
  "mutedDirection",
  "sameFileNodeMoved",
  "placeholderReserved",
  "backgroundInert",
  "focusContained",
  "fileStatePreserved",
  "chartWorkspaceOpened",
  "pageErrors",
]) {
  assert.ok(runtimeSource.includes(token), `Priority Chromium smoke missing ${token}`);
}

assert.ok(workflowSource.includes('"scripts/testPriorityPolishRuntime.mjs"'));
assert.ok(workflowSource.includes("node scripts/testPriorityPolishRuntime.mjs"));

console.log("Priority runtime contract passed: CI executes the integrated Priority 1–3 Chromium regression smoke.");
