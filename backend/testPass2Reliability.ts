import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = fs.readFileSync(path.join(root, "backend", "server.ts"), "utf8");
const memoryService = fs.readFileSync(path.join(root, "backend", "services", "memoryService.ts"), "utf8");
const contextBuilder = fs.readFileSync(path.join(root, "backend", "context", "contextBuilder.ts"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260504120000_add_memory_embeddings.sql"),
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
  assert(contextBuilder.includes("scheduleCloudMemoryEmbeddingBackfill"), "context builder schedules embedding backfill");
  assert(contextBuilder.includes(".select(\"id, summary, type, importance, embedding"), "cloud memories fetch embeddings");
}

console.log("Pass 2 reliability checks passed.");
