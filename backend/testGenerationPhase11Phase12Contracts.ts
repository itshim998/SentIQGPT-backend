import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const runner = fs.readFileSync(path.resolve(__dirname, "services/generationRunner.ts"), "utf8");
const rehydrationRoutes = fs.readFileSync(path.resolve(__dirname, "chatGenerationRehydrationRoutes.ts"), "utf8");
const rehydration = fs.readFileSync(path.resolve(__dirname, "../frontend/scripts/generation-rehydration.js"), "utf8");
const bootstrap = fs.readFileSync(path.resolve(__dirname, "../frontend/scripts/bootstrap-guard.js"), "utf8");

test("Phase 11 exposes conversation-scoped durable generation state", () => {
  assert.match(rehydrationRoutes, /\/api\/conversations\/:conversationId\/generations/);
  assert.match(rehydrationRoutes, /chat_generations/);
  assert.match(rehydration, /generation-state-rehydrated/);
  assert.match(rehydration, /SentIQChatGenerationRegistry/);
  assert.match(rehydration, /flushChat/);
});

test("Phase 11 loads lifecycle, render routing, then rehydration", () => {
  const lifecycle = bootstrap.indexOf("generation-lifecycle.js");
  const router = bootstrap.indexOf("generation-render-router.js");
  const hydrate = bootstrap.indexOf("generation-rehydration.js");
  assert.ok(lifecycle >= 0 && router > lifecycle && hydrate > router);
});

test("Phase 12 binds explicit cancellation to the generation executor AbortSignal", () => {
  assert.match(runner, /AbortController/);
  assert.match(runner, /signal: abortController\.signal/);
  assert.match(runner, /sentiq-generation-cancel/);
  assert.match(runner, /request\.emit\("close"\)/);
  assert.match(runner, /request\.signal\.aborted/);
});

test("Phase 12 keeps browser transport detached from executor cancellation", () => {
  assert.match(runner, /__sentiqGenerationDetached: true/);
  assert.match(
    runner,
    /once\("close", \(\) => \{ if \(!abortController\.signal\.aborted && request\.__sentiqGenerationDetached !== true\) abort\(\); \}\)/,
  );
  assert.doesNotMatch(runner, /const executionHandle: ChatGenerationExecution/);
});
