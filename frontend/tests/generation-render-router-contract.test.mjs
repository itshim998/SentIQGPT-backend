import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const router = fs.readFileSync(new URL("../scripts/generation-render-router.js", import.meta.url), "utf8");
const bootstrap = fs.readFileSync(new URL("../scripts/bootstrap-guard.js", import.meta.url), "utf8");

test("Phase 9 routes generation callbacks through conversation and generation identity", () => {
  assert.match(router, /conversationId/);
  assert.match(router, /generationId/);
  assert.match(router, /getChatRegistry\(conversationId/);
  assert.match(router, /callbacks/);
  assert.match(router, /pendingCallbacks/);
  assert.match(router, /flushChat/);
});

test("Phase 9 buffers off-screen generation output and flushes it when its chat becomes visible", () => {
  assert.match(router, /if \(!entry \|\| !isVisible\(entry\)\) return;/);
  assert.match(router, /entry\.pendingCallbacks\.push/);
  assert.match(router, /flushEntry\(entry\)/);
  assert.match(router, /getVisibleConversationId/);
});

test("Phase 10 derives sidebar state from generation state rather than the active DOM", () => {
  assert.match(router, /RUNNING/);
  assert.match(router, /data-generation-state/);
  assert.match(router, /Generating/);
  assert.match(router, /Response ready/);
  assert.match(router, /SentIQChatGenerationRegistry/);
});

test("generation state retains the requested Phase 8 registry fields", () => {
  for (const field of ["generationId", "requestId", "status", "responseBuffer", "lastSequence", "subscription", "startedAt", "completedAt"]) {
    assert.match(router, new RegExp(field));
  }
});

test("bootstrap installs the renderer router after durable lifecycle transport", () => {
  assert.match(bootstrap, /import\("\.\/generation-lifecycle\.js"\)/);
  assert.match(bootstrap, /import\("\.\/generation-render-router\.js"\)/);
});
