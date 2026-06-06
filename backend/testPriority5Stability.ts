import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chunkText } from "./context/fileChunker";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const server = read("backend/server.ts");
const rateLimiter = read("backend/middleware/rateLimiter.ts");
const imageRouter = read("backend/tools/imageGeneration/imageRouter.ts");
const toolExecutor = read("backend/orchestrator/toolExecutor.ts");
const conversationService = read("backend/services/conversationService.ts");
const dbRouter = read("backend/dbRouter.ts");
const migration = read("supabase/migrations/20260522140000_list_user_conversations.sql");
const activityMigration = read("supabase/migrations/20260528120000_conversation_last_activity.sql");
const architecture = read("docs/ARCHITECTURE.md");

function assertOrder(source: string, before: string, after: string, message: string): void {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert(beforeIndex >= 0, `Missing before marker: ${before}`);
  assert(afterIndex >= 0, `Missing after marker: ${after}`);
  assert(beforeIndex < afterIndex, message);
}

function functionBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `Missing block start ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end > start, `Missing block end ${endMarker}`);
  return source.slice(start, end);
}

assert(server.includes("function shutdownProcess"), "fatal shutdown uses a shared shutdown function");
assert(server.includes("process.on(\"uncaughtException\", (err) => {\n  shutdownProcess(\"FATAL uncaught exception\", 1, err);"), "uncaught exceptions trigger shutdown");
assert(server.includes("process.on(\"unhandledRejection\", (reason) => {\n  shutdownProcess(\"FATAL unhandled rejection\", 1, reason);"), "unhandled rejections trigger shutdown");
assert(!server.includes("kept alive"), "fatal handlers must not keep the process alive");
assert(server.includes("SENTIQ_SHUTDOWN_GRACE_MS"), "shutdown grace period is configurable");

assert(server.includes("async function attachRateLimitIdentity"), "server has pre-rate-limit identity resolver");
assertOrder(server, "app.use(attachRateLimitIdentity);", "app.use(generalRateLimiter);", "identity is resolved before the general limiter");
assert(rateLimiter.includes("return `user:${user.sub}`"), "rate limiter keys signed-in users by user id");

assert(imageRouter.includes("const imageQueuesByUser"), "image router uses per-user queues");
assert(imageRouter.includes("const readyUserKeys"), "image router tracks fair ready users");
assert(imageRouter.includes("SENTIQ_IMAGE_QUEUE_MAX_PER_USER"), "image router has a per-user queue limit");
assert(imageRouter.includes("SENTIQ_IMAGE_QUEUE_CONCURRENCY"), "image router has configurable bounded concurrency");
assert(imageRouter.includes("function removeQueuedItem"), "queued image jobs can be removed on abort");
assert(imageRouter.includes("readonly userId?: string"), "image route input accepts user id");
assert(imageRouter.includes("readonly signal?: AbortSignal"), "image route input accepts abort signal");
assert(server.includes("userId,\n      });"), "image endpoint passes user id into image routing");
assert(toolExecutor.includes("routeImageGeneration({ prompt: input, userId: ctx.userId, signal, preferredModel"), "orchestrator image tool passes user, signal, and image model preference");

const getUserConversationsBlock = functionBlock(
  conversationService,
  "export async function getUserConversations",
  "export async function getUserConversationsOldestFirst",
);
assert(getUserConversationsBlock.includes(".rpc(\"list_user_conversations\""), "conversation list uses aggregate RPC");
assert(!getUserConversationsBlock.includes(".from(\"messages\")"), "conversation list does not fetch all messages in backend");
assert(migration.includes("create or replace function public.list_user_conversations"), "migration creates list_user_conversations RPC");
assert(migration.includes("left join lateral"), "conversation-list RPC uses lateral aggregate lookups");
assert(activityMigration.includes("messages_touch_conversation_last_activity"), "activity migration maintains conversation timestamps from message inserts");
assert(activityMigration.includes("conversations_user_last_activity_idx"), "activity migration indexes per-user activity ordering");
assert(dbRouter.includes("client.rpc(\"list_user_conversations\""), "startup verification checks list_user_conversations");
assert(dbRouter.includes("conversations.last_activity_at activity tracking"), "startup verification checks last_activity_at dependency");

const chunks = chunkText("abcdefghij", "sample.txt", 3, 99);
assert(chunks.length > 1, "chunker still splits long text");
assert(chunks.length <= 10, "chunker makes bounded progress when overlap exceeds chunk size");
assert(chunks.every((chunk) => chunk.text.length > 0), "chunker does not emit empty chunks for normal input");
assert(architecture.includes("list_user_conversations(p_user_id)"), "architecture docs mention scalable conversation listing");
assert(architecture.includes("per-user queues"), "architecture docs mention image queue hardening");

console.log("Priority 5 stability checks passed.");
