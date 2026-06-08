import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = fs.readFileSync(path.join(root, "backend", "server.ts"), "utf8");
const promptBuilders = fs.readFileSync(path.join(root, "backend", "ai", "PromptBuilders.ts"), "utf8");
const orchestrator = fs.readFileSync(path.join(root, "backend", "orchestrator", "aiOrchestrator.ts"), "utf8");
const toolExecutor = fs.readFileSync(path.join(root, "backend", "orchestrator", "toolExecutor.ts"), "utf8");
const llmService = fs.readFileSync(path.join(root, "backend", "llm_service.py"), "utf8");
const llmAdapter = fs.readFileSync(path.join(root, "llm_adapter.py"), "utf8");
const memoryService = fs.readFileSync(path.join(root, "backend", "services", "memoryService.ts"), "utf8");
const contextBuilder = fs.readFileSync(path.join(root, "backend", "context", "contextBuilder.ts"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260504120000_add_memory_embeddings.sql"),
  "utf8",
);
const memoryMaintenanceMigration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260522130000_memory_maintenance.sql"),
  "utf8",
);

function routeBlock(route: string): string {
  const needle = `"${route}"`;
  const index = server.indexOf(needle);
  assert(index >= 0, `Missing route ${route}`);
  const end = server.indexOf(");", index);
  assert(end > index, `Missing end for route ${route}`);
  return server.slice(index, end);
}

function assertAuthBeforeLimiter(route: string): void {
  const block = routeBlock(route);
  const authIndex = block.indexOf("verifyJWT(");
  const limiterIndex = Math.min(
    ...["aiRateLimiter", "uploadRateLimiter"].map((name) => {
      const idx = block.indexOf(name);
      return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
    }),
  );
  assert(authIndex >= 0, `${route} should resolve auth before rate limiting`);
  assert(limiterIndex < Number.POSITIVE_INFINITY, `${route} should have a limiter`);
  assert(authIndex < limiterIndex, `${route} should key limiter by authenticated user when possible`);
}

{
  const deleteBlock = server.slice(
    server.indexOf("async function deleteMemoryIfOwned"),
    server.indexOf("async function listConversationsOrThrow"),
  );
  assert(deleteBlock.indexOf("deleteMemory(userDb, memoryId, userId)") < deleteBlock.indexOf("decrementUserMemoryUsage"), "memory rows are deleted before usage decrement");
  assert(deleteBlock.includes("memory-delete.usage-repair-needed"), "counter drift emits repair-needed event");
  assert(!deleteBlock.includes("incrementUserMemoryUsage(userDb, userId, memoryBytes).catch"), "delete failure rollback no longer silently swallows counter repair");
}

{
  const listBlock = server.slice(
    server.indexOf("async function listConversationMessagesOrThrow"),
    server.indexOf("async function updateConversationTitleIfOwned"),
  );
  assert(listBlock.includes("skipOwnershipCheck"), "message listing supports a single ownership check");
  assert(server.includes("{ skipOwnershipCheck: true }"), "conversation message route reuses prior ownership check");
}

{
  assert(server.includes("function getFileSessionKey"), "file sessions use a stable helper");
  assert(server.includes("return `user:${userId}`"), "signed-in file sessions are keyed by user id");
  assert(server.includes("fileSessionMap.set(fileSessionKey"), "file upload stores session by user key");
}

{
  assert(orchestrator.includes("function createOrchestratorAbortSignal"), "orchestrator should create an abortable timeout signal");
  assert(orchestrator.includes("_orchestrateInner({ ...request, signal: abort.signal })"), "orchestrator should pass timeout/request signal into inner work");
  assert(orchestrator.includes("executePlan(finalPlan.steps, ctx, { profile, signal })"), "orchestrator should pass abort signals into plan execution");
  assert(!orchestrator.includes("const executionPromise = executePlan"), "web-search orchestration should not start execution before clarification");
  assert(toolExecutor.includes("throwIfAborted(signal)"), "tool executor should check cancellation between steps");
  assert(!toolExecutor.includes("PARALLELIZABLE_TOOLS"), "side-effectful tools should not be grouped as parallelizable");
  assert(!toolExecutor.includes("Promise.all(group"), "executor should not use Promise.all for side-effectful tool groups");
  assert(promptBuilders.includes("readonly signal?: AbortSignal"), "LLM adapter calls should accept caller abort signals");
  assert(promptBuilders.includes("signal: abort.signal"), "LLM adapter fetch calls should use the composed abort signal");
  assert(promptBuilders.includes("async cancel(reason)"), "LLM stream wrapper should cancel upstream readers");
  assert(server.includes("requestAbortController.abort(new Error(\"Client disconnected\"))"), "stream route should abort upstream work on disconnect");
  assert(server.includes("if (fullReply && !clientDisconnected)"), "stream route should not persist partial output after disconnect");
}

{
  assert(llmAdapter.includes('DEGRADED = "DEGRADED"'), "safety adapter should expose degraded safety state");
  assert(!llmAdapter.includes("defaulting to SAFE"), "safety failures should not fail open as SAFE");
  assert(llmAdapter.includes("classification in {SafetyResult.SAFE, SafetyResult.CONTROVERSIAL}"), "safety helper should fail closed on degraded checks");
  assert(llmService.includes("def check_output_safety"), "streaming service should have a final output safety check");
  assert(llmService.includes("check_output_safety(final_output, user_id, \"/llm/stream\", request.task)"), "streaming service should check short final output before completion");
  assert(llmService.includes("output_classification in EXPLICIT_BLOCKED_CLASSIFICATIONS"), "streaming service should block explicit unsafe output");
  assert(llmService.includes("safety.output.timeout.degraded"), "streaming service should degrade gracefully on output safety timeout");
  assert(llmService.indexOf("check_output_safety(final_output") < llmService.indexOf('yield "data: [DONE]'), "final stream safety should run before DONE");
}

{
  assert(server.includes("const fileAnalysisSubscribersByUser"), "file-analysis SSE subscribers should be scoped by user");
  assert(server.includes("function registerFileAnalysisSubscriber"), "file-analysis SSE registration should preserve user ownership");
  assert(server.includes("function unregisterFileAnalysisSubscriber"), "file-analysis SSE cleanup should preserve user ownership");
  assert(server.includes("registerFileAnalysisSubscriber(userId, subscriberId, writer)"), "file update stream should register under the authenticated user");
  assert(server.includes("emitFileAnalysisEvent(isGuest ? undefined : userId"), "file upload should emit only to the upload owner");
  assert(!server.includes("const fileAnalysisSubscribers: Map<string, SseWriter>"), "file-analysis SSE must not use a global broadcast subscriber map");
  const eventTypeStart = server.indexOf("type FileAnalysisEvent");
  const eventTypeEnd = server.indexOf("};", eventTypeStart);
  assert(eventTypeStart >= 0 && eventTypeEnd > eventTypeStart, "file analysis event type should exist");
  assert(!server.slice(eventTypeStart, eventTypeEnd).includes("extracted_text"), "SSE file-analysis events must not carry extracted document text");
  const completionEmitStart = server.indexOf('event: "update"', server.indexOf("emitFileAnalysisEvent(isGuest ? undefined : userId"));
  const completionEmitEnd = server.indexOf("});", completionEmitStart);
  assert(completionEmitStart >= 0 && completionEmitEnd > completionEmitStart, "file upload completion SSE emit should exist");
  assert(!server.slice(completionEmitStart, completionEmitEnd).includes("extracted_text"), "file upload completion SSE must be status-only");
}

{
  assert(server.includes("console.error(`[IMAGE_STORE] failed"), "raw image-store errors remain server-side");
  assert(server.includes('res.status(500).json({ error: "Failed to store image." })'), "image-store client error is sanitized");
}

for (const route of [
  "/api/chat",
  "/api/chat/stream",
  "/api/memory/classify",
  "/api/memory/compress",
  "/api/files/updates",
  "/api/files/upload",
  "/api/charts/generate",
  "/api/chat/selection",
]) {
  assertAuthBeforeLimiter(route);
}

{
  assert(migration.includes("embedding jsonb"), "migration adds memory embedding jsonb");
  assert(migration.includes("embedding_model text"), "migration adds embedding model");
  assert(migration.includes("embedding_created_at timestamptz"), "migration adds embedding timestamp");
  assert(memoryService.includes("embedding_model"), "memory service persists embedding metadata");
  assert(contextBuilder.includes("await maintainCloudMemoryEmbeddings"), "context builder runs bounded durable embedding maintenance");
  assert(memoryMaintenanceMigration.includes("embedding_backfill_requested_at"), "maintenance migration adds durable embedding backfill queue metadata");
  assert(contextBuilder.includes("id, summary, type, importance, embedding"), "cloud memories fetch embeddings");
}

console.log("Pass 2 reliability checks passed.");
