import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lifecycle = fs.readFileSync(new URL("../scripts/generation-lifecycle.js", import.meta.url), "utf8");
const bootstrap = fs.readFileSync(new URL("../scripts/bootstrap-guard.js", import.meta.url), "utf8");

test("Phase 4 lifecycle adapter uses durable generation endpoints", () => {
  assert.match(lifecycle, /API\.sendMessage\(message/);
  assert.match(lifecycle, /\/api\/chat\/generations\/\$\{encodeURIComponent\(entry\.generationId\)\}\/events/);
  assert.match(lifecycle, /\/api\/chat\/generations\/\$\{encodeURIComponent\(generationId\)\}\/cancel/);
  assert.match(lifecycle, /\/api\/chat\/generations\/cancel-all/);
});

test("Phase 4 lifecycle distinguishes Stop and transport teardown", () => {
  assert.match(lifecycle, /closest\("#send-btn"\)/);
  assert.match(lifecycle, /classList\.contains\("is-stop"\)/);
  assert.match(lifecycle, /entry\.cancelRequested = true/);
  assert.match(lifecycle, /pagehide/);
  assert.match(lifecycle, /beforeunload/);
  assert.match(lifecycle, /AbortError/);
  assert.match(lifecycle, /detached/);
});

test("Phase 4 lifecycle retries transient SSE disconnects", () => {
  assert.match(lifecycle, /MAX_RECONNECT_ATTEMPTS/);
  assert.match(lifecycle, /RECONNECT_BASE_MS/);
  assert.match(lifecycle, /after/);
  assert.match(lifecycle, /subscribeUntilTerminal/);
});

test("Phase 7 stores monotonically increasing sequences and recovers gaps from the last contiguous event", () => {
  assert.match(lifecycle, /lastSequence/);
  assert.match(lifecycle, /generation_sequence_gap/);
  assert.match(lifecycle, /expected .* received/);
  assert.match(lifecycle, /searchParams\.set\("after", String\(entry\.lastSequence\)\)/);
  assert.match(lifecycle, /pendingReplayThrough/);
});

test("Phase 8 maintains independent per-chat generation registries", () => {
  assert.match(lifecycle, /chatGenerationRegistry/);
  assert.match(lifecycle, /getChatRegistry\(entry\.chatId\)/);
  assert.match(lifecycle, /generationId: entry\.generationId/);
  assert.match(lifecycle, /requestId: entry\.requestId/);
  assert.match(lifecycle, /responseBuffer: entry\.responseBuffer/);
  assert.match(lifecycle, /lastSequence: entry\.lastSequence/);
  assert.match(lifecycle, /startedAt: entry\.startedAt/);
  assert.match(lifecycle, /completedAt: entry\.completedAt/);
  assert.match(lifecycle, /getChatGenerations/);
});

test("Phase 8 generation ownership prefers the creating conversation over the currently visible chat", () => {
  assert.match(lifecycle, /context\.conversationId/);
  assert.match(lifecycle, /started\?\.conversation_id/);
  assert.match(lifecycle, /chat-list-item\.active/);
});

test("bootstrap loads the lifecycle adapter after UI readiness", () => {
  assert.match(bootstrap, /sentiq-ui-ready/);
  assert.match(bootstrap, /generation-lifecycle\.js/);
});
