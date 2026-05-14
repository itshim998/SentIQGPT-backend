import assert from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  getMemoryConfirmationText,
  isChatScopedMemoryRequest,
  MEMORY_PERSISTENCE_FAILURE_TEXT,
  resolveMemoryScopeForRequest,
} from "./memory/memoryScope";
import { selectMemoriesForQuery } from "./context/memorySelector";
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
}

function main() {
  assertMemoryScopeContract();
  assertDeterministicRecallFallback();
  assertStaticPersistenceContract();
  assertPromptContract();
  assertFrontendContract();
  console.log("Pass 3 memory reliability tests passed.");
}

main();
