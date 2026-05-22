import assert from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  getMemoryConfirmationText,
  isChatScopedMemoryRequest,
  MEMORY_PERSISTENCE_FAILURE_TEXT,
  resolveMemoryScopeForRequest,
} from "./memory/memoryScope";
import { processMessageForMemory } from "./ai/MemoryProcessor";
import { selectMemoriesForQuery } from "./context/memorySelector";
import { filterSemanticResultsByThreshold } from "./memory/semanticSearch";
import { readFrontendSources } from "./frontendSource";

function assertMemoryScopeContract() {
  assert.strictEqual(
    resolveMemoryScopeForRequest({ scope: undefined }, "I am currently working on a health chat assistant. Remember that for future reference."),
    "global",
    "new project/future-reference memories should default to workspace/global scope",
  );
  assert.strictEqual(
    resolveMemoryScopeForRequest({ scope: undefined }, "Remember this only for this chat."),
    "chat",
    "explicit chat-only memory requests should remain chat scoped",
  );
  assert.strictEqual(isChatScopedMemoryRequest("Please save this in this conversation only."), true);
  assert.strictEqual(getMemoryConfirmationText("global"), "Got it. I've remembered that across chats.");
  assert.strictEqual(getMemoryConfirmationText("chat"), "Got it. I've remembered that for this chat.");
  assert.ok(MEMORY_PERSISTENCE_FAILURE_TEXT.includes("couldn't save"));
}

function assertDeterministicRecallFallback() {
  const selected = selectMemoriesForQuery(
    [
      {
        type: "project",
        summary: "Working on a health chat assistant project",
        importance: 8,
      },
    ],
    "Do you remember the health chatbot?",
    3,
  );
  assert.strictEqual(selected.length, 1, "health chatbot should match health chat assistant project");
}

function assertStaticPersistenceContract() {
  const root = resolve(__dirname, "..");
  const serverSource = readFileSync(resolve(root, "backend", "server.ts"), "utf8");
  assert.ok(
    serverSource.includes("resolveMemoryScopeForRequest(result.memory, parsed.data.message)"),
    "server should resolve memory scope from explicit chat-only language",
  );
  assert.ok(
    !serverSource.includes('result.memory.type === "project" ? "chat" : "global"'),
    "server must not force project memories to chat scope",
  );
  assert.ok(
    serverSource.includes("getMemoryConfirmationText(responseMemory.scope") &&
    serverSource.includes("MEMORY_PERSISTENCE_FAILURE_TEXT"),
    "server should gate memory confirmation on durable persistence outcome",
  );
  assert.ok(
    serverSource.includes("repairUserMemoryUsage") &&
    serverSource.includes("memory-delete.usage-repair.ok"),
    "server should repair memory usage counter drift after delete adjustment failures",
  );
}

function assertPromptContract() {
  const root = resolve(__dirname, "..");
  const promptSource = readFileSync(resolve(root, "backend", "ai", "PromptBuilders.ts"), "utf8");
  assert.ok(
    promptSource.includes("SAVED MEMORY CONTEXT contains durable user facts"),
    "prompt should treat saved memory as durable user facts",
  );
  assert.ok(
    promptSource.includes("Saved memory is not transcript evidence"),
    "prompt should avoid claiming exact prior transcript from memory alone",
  );
}

function assertFrontendContract() {
  const root = resolve(__dirname, "..");
  const frontendSource = readFrontendSources(root).combined;
  assert.ok(
    frontendSource.includes('return "global";'),
    "frontend memory scope fallback should default to global",
  );
  assert.ok(
    !frontendSource.includes('type === "project" ? "chat" : "global"'),
    "frontend must not force project memories into chat scope",
  );
  assert.ok(
    frontendSource.includes("Across chats") &&
    frontendSource.includes("Single chat") &&
    frontendSource.includes("memory-scope-badge"),
    "frontend should show persisted memory trust state and scope badges",
  );
  assert.ok(
    frontendSource.includes("memoryResult.persisted !== false"),
    "frontend should avoid storing failed durable memory saves as trusted memories",
  );
  assert.ok(
    frontendSource.includes("Array.isArray(memory.embedding) ? memory.embedding") &&
    frontendSource.includes("failure_reason: memory.failure_reason"),
    "frontend should preserve memory embedding and failure metadata",
  );
}

async function assertDeterministicMemoryFallback() {
  const result = await processMessageForMemory({
    message: "Remember my name is Soumo.",
    forceStore: true,
    generateEmbedding: false,
  });
  assert.strictEqual(result.stored, true, "explicit identity memory should store without live summarizer dependency");
  assert.strictEqual(result.memory?.type, "identity");
  assert.strictEqual(result.memory?.summary, "User's name is Soumo.");
}

async function assertForceStoreBypassesExplicitPhraseOnlyForTypedMemories() {
  const forced = await processMessageForMemory({
    message: "My name is Soumo.",
    forceStore: true,
    generateEmbedding: false,
  });
  assert.strictEqual(forced.stored, true, "forceStore should store typed memory without remember/save wording");
  assert.strictEqual(forced.memory?.type, "identity");

  const implicit = await processMessageForMemory({
    message: "My name is Soumo.",
    generateEmbedding: false,
  });
  assert.strictEqual(implicit.stored, false, "implicit personal facts should not store without explicit intent");
  assert.strictEqual(implicit.failure_reason, "explicit_intent_missing");
}

function assertMemoryMetadataMergeContract() {
  const root = resolve(__dirname, "..");
  const orchestratorSource = readFileSync(resolve(root, "backend", "orchestrator", "aiOrchestrator.ts"), "utf8");
  const executorSource = readFileSync(resolve(root, "backend", "orchestrator", "toolExecutor.ts"), "utf8");

  assert.ok(
    orchestratorSource.includes("...step.memory") &&
    orchestratorSource.includes("embedding?: readonly number[]") &&
    orchestratorSource.includes("failure_reason?: string"),
    "orchestrator merge should preserve full memory metadata",
  );
  assert.ok(
    executorSource.includes("...memResult.memory") &&
    executorSource.includes("failure_reason: memResult.failure_reason") &&
    executorSource.includes("embedding?: readonly number[]"),
    "tool executor should preserve memory pipeline metadata",
  );
}

function assertSemanticThresholdContract() {
  const filtered = filterSemanticResultsByThreshold(
    [
      { memory: { type: "project", summary: "Relevant memory" }, similarity: 0.81 },
      { memory: { type: "project", summary: "Noisy memory" }, similarity: 0.12 },
    ],
    0.72,
  );
  assert.strictEqual(filtered.length, 1, "semantic search should reject low-similarity memories");
  assert.strictEqual(filtered[0].memory.summary, "Relevant memory");
}

function assertMemoryMaintenanceContract() {
  const root = resolve(__dirname, "..");
  const contextSource = readFileSync(resolve(root, "backend", "context", "contextBuilder.ts"), "utf8");
  const maintenanceSource = readFileSync(resolve(root, "backend", "memory", "memoryMaintenance.ts"), "utf8");
  const migrationSource = readFileSync(resolve(root, "supabase", "migrations", "20260522130000_memory_maintenance.sql"), "utf8");

  assert.ok(
    contextSource.includes('.eq("scope", "global")') &&
    contextSource.includes('.eq("scope", "chat")') &&
    contextSource.includes("await maintainCloudMemoryEmbeddings"),
    "cloud memory retrieval should scope before limiting and run bounded durable maintenance",
  );
  assert.ok(
    !contextSource.includes("scheduleCloudMemoryEmbeddingBackfill"),
    "embedding backfill should not be fire-and-forget from context builder",
  );
  assert.ok(
    maintenanceSource.includes("enqueueMemoryEmbeddingBackfill") &&
    maintenanceSource.includes("processQueuedMemoryEmbeddingBackfill") &&
    maintenanceSource.includes("embedding_backfill_requested_at"),
    "memory maintenance helper should enqueue and process durable embedding backfill state",
  );
  assert.ok(
    migrationSource.includes("repair_user_memory_usage") &&
    migrationSource.includes("embedding_backfill_requested_at") &&
    migrationSource.includes("idx_memories_embedding_backfill_queue"),
    "memory maintenance migration should add backfill metadata and counter repair RPC",
  );
}

async function main() {
  assertMemoryScopeContract();
  assertDeterministicRecallFallback();
  assertStaticPersistenceContract();
  assertPromptContract();
  assertFrontendContract();
  await assertDeterministicMemoryFallback();
  await assertForceStoreBypassesExplicitPhraseOnlyForTypedMemories();
  assertMemoryMetadataMergeContract();
  assertSemanticThresholdContract();
  assertMemoryMaintenanceContract();
  console.log("Pass 3 memory reliability tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
