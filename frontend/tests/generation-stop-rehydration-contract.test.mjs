import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lifecycle = fs.readFileSync(new URL("../scripts/generation-lifecycle.js", import.meta.url), "utf8");
const router = fs.readFileSync(new URL("../scripts/generation-render-router.js", import.meta.url), "utf8");

test("rehydrated generations are registered in the lifecycle active set", () => {
  assert.match(router, /lifecycle\.registerExternalGeneration\(\{/);
  assert.match(lifecycle, /activeGenerations\.set\(generationId, canonical\)/);
});

test("cancelGeneration resolves the canonical registry entry even without an active-map handle", () => {
  assert.match(lifecycle, /const entry = getGenerationEntry\(generationId\);/);
  assert.match(lifecycle, /activeGenerations\.set\(generationId, entry\)/);
});

test("explicit Stop resolves a running generation from the canonical registry", () => {
  assert.match(lifecycle, /function getStopTargetEntry\(\)/);
  assert.match(lifecycle, /getGenerationEntries\(visibleChatId\)\.filter\(isGenerationRunning\)/);
  assert.match(lifecycle, /const entry = getStopTargetEntry\(\);/);
  assert.match(lifecycle, /const generationId = entry\?\.generationId \|\| null;/);
});

test("Stop remains compatible with the pre-generation race", () => {
  assert.match(lifecycle, /pendingGenerationStarts > 0/);
  assert.match(lifecycle, /stopRequestedBeforeGeneration = true/);
});
