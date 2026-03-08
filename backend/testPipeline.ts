// SentIQGPT — Integration Test Pipeline
//
// Validates the full intelligence pipeline: orchestrator routing,
// tool detection, memory storage/retrieval, and image generation.
//
// Usage:  npm run test:pipeline
// Requires:  LLM service running on port 3002  (npm run llm-service)

import * as dotenv from "dotenv";
dotenv.config();

import { orchestrate } from "./orchestrator/aiOrchestrator";
import type { OrchestratorResponse } from "./orchestrator/aiOrchestrator";

// ─────────────────────────────
// Helpers
// ─────────────────────────────

const PASS = "\x1b[32m✓ PASS\x1b[0m";
const FAIL = "\x1b[31m✗ FAIL\x1b[0m";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL}  ${label}${detail ? `  —  ${detail}` : ""}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  TEST: ${title}`);
  console.log(`${"═".repeat(60)}`);
}

// ─────────────────────────────
// Test 1 — Normal Conversation
// ─────────────────────────────

async function testNormalConversation(): Promise<void> {
  section("Normal Conversation");

  const res: OrchestratorResponse = await orchestrate({
    userMessage: "Explain what a neural network is.",
  });

  console.log(`  route: ${res.route}  |  reply length: ${res.reply?.length ?? 0}`);

  assert(
    res.route === "normal_chat" || res.route === "knowledge_query",
    "Route is normal_chat or knowledge_query",
    `got: ${res.route}`,
  );
  assert(!!res.reply && res.reply.length > 20, "Reply is non-trivial", `length: ${res.reply?.length}`);
  assert(typeof res.confidence === "number" && res.confidence > 0, "Confidence > 0", `got: ${res.confidence}`);
}

// ─────────────────────────────
// Test 2 — Image Generation
// ─────────────────────────────

async function testImageGeneration(): Promise<void> {
  section("Image Generation");

  const res: OrchestratorResponse = await orchestrate({
    userMessage: "Generate an image of a futuristic cyberpunk city at night.",
  });

  console.log(`  route: ${res.route}  |  image success: ${res.image?.success}  |  provider: ${res.image?.provider_used ?? "none"}`);

  assert(res.route === "image_generation", "Route is image_generation", `got: ${res.route}`);
  assert(!!res.image, "Image payload present");
  if (res.image) {
    assert(res.image.success === true, "Image generation succeeded");
    assert(!!res.image.image_url || !!res.image.image_base64, "Image URL or base64 present");
    assert(!!res.image.provider_used, "Provider name recorded", `provider: ${res.image.provider_used}`);
  }
}

// ─────────────────────────────
// Test 3 — Memory Storage
// ─────────────────────────────

async function testMemoryStorage(): Promise<OrchestratorResponse> {
  section("Memory Storage");

  const res: OrchestratorResponse = await orchestrate({
    userMessage: "I am building an AI assistant called SentIQGPT. It uses Gemini and Groq together.",
  });

  console.log(`  route: ${res.route}  |  memory stored: ${res.memory.stored}  |  type: ${res.memory.type ?? "n/a"}`);

  assert(res.memory.stored === true, "Memory was stored", `stored: ${res.memory.stored}`);
  if (res.memory.stored) {
    assert(!!res.memory.type, "Memory type assigned", `type: ${res.memory.type}`);
    assert(!!res.memory.summary, "Memory summary generated");
    assert(
      typeof res.memory.importance === "number" && res.memory.importance > 0,
      "Importance > 0",
      `importance: ${res.memory.importance}`,
    );
  }

  return res;
}

// ─────────────────────────────
// Test 4 — Memory Retrieval
// ─────────────────────────────

async function testMemoryRetrieval(storedMemory: OrchestratorResponse): Promise<void> {
  section("Memory Retrieval");

  // Feed the stored memory back as context so the LLM can use it
  const memories = storedMemory.memory.stored
    ? [
        {
          type: storedMemory.memory.type ?? "project",
          summary: storedMemory.memory.summary ?? "",
          importance: storedMemory.memory.importance ?? 5,
        },
      ]
    : [];

  const res: OrchestratorResponse = await orchestrate({
    userMessage: "What project am I working on?",
    context: {
      memories,
    },
  });

  console.log(`  route: ${res.route}  |  reply length: ${res.reply?.length ?? 0}`);

  assert(
    res.route === "normal_chat" || res.route === "knowledge_query" || res.route === "memory_update",
    "Routed to chat/knowledge/memory",
    `got: ${res.route}`,
  );
  assert(!!res.reply, "Reply present");

  const replyLower = (res.reply ?? "").toLowerCase();
  assert(
    replyLower.includes("sentiqgpt") || replyLower.includes("ai assistant") || replyLower.includes("project"),
    "Reply references stored context (SentIQGPT / AI assistant / project)",
    `reply snippet: "${(res.reply ?? "").slice(0, 120)}"`,
  );
}

// ─────────────────────────────
// Runner
// ─────────────────────────────

async function run(): Promise<void> {
  console.log("\n🔬 SentIQGPT Integration Test Pipeline");
  console.log("────────────────────────────────────────");

  const start = Date.now();

  try {
    await testNormalConversation();
  } catch (err) {
    console.log(`  ${FAIL}  Test 1 threw: ${err instanceof Error ? err.message : err}`);
    failed++;
  }

  try {
    await testImageGeneration();
  } catch (err) {
    console.log(`  ${FAIL}  Test 2 threw: ${err instanceof Error ? err.message : err}`);
    failed++;
  }

  let memRes: OrchestratorResponse | null = null;
  try {
    memRes = await testMemoryStorage();
  } catch (err) {
    console.log(`  ${FAIL}  Test 3 threw: ${err instanceof Error ? err.message : err}`);
    failed++;
  }

  try {
    if (memRes) {
      await testMemoryRetrieval(memRes);
    } else {
      console.log(`  ${FAIL}  Test 4 skipped — Test 3 did not produce a memory result`);
      failed++;
    }
  } catch (err) {
    console.log(`  ${FAIL}  Test 4 threw: ${err instanceof Error ? err.message : err}`);
    failed++;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS:  ${passed} passed  /  ${failed} failed  (${elapsed}s)`);
  console.log(`${"═".repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
