// SentIQ Chat — Integration Test Pipeline
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
import type { RendererType } from "./tools/chartGeneration/types";

// ─────────────────────────────
// Helpers
// ─────────────────────────────

const PASS = "\x1b[32m✓ PASS\x1b[0m";
const FAIL = "\x1b[31m✗ FAIL\x1b[0m";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

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
  assert((res.answer ?? res.reply) === res.reply, "Structured answer mirrors user-facing reply for compatibility");
  assert(!/<think>/i.test(res.reply ?? ""), "Public reply does not leak think tags");
  assert(res.memory.stored === false, "Memory is not auto-stored for normal conversation", `stored: ${res.memory.stored}`);
  assert(typeof res.confidence === "number" && res.confidence > 0, "Confidence > 0", `got: ${res.confidence}`);
}

// ─────────────────────────────
// Test 2 — Image Generation
// ─────────────────────────────

async function testImageGeneration(): Promise<void> {
  section("Image Generation");

  const originalFetch = globalThis.fetch;
  const originalPollinationsKey = process.env.POLLINATIONS_API_KEY;
  process.env.POLLINATIONS_API_KEY = originalPollinationsKey || "test-pollinations-key";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://gen.pollinations.ai/image/")) {
      const body = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
      return {
        ok: true,
        status: 200,
        headers: {
          get(name: string) {
            return name.toLowerCase() === "content-type" ? "image/png" : null;
          },
        },
        async arrayBuffer() {
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        },
      } as Response;
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;

  let res: OrchestratorResponse;
  try {
    res = await orchestrate({
      userMessage: "Generate an image of a futuristic cyberpunk city at night.",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPollinationsKey === undefined) {
      delete process.env.POLLINATIONS_API_KEY;
    } else {
      process.env.POLLINATIONS_API_KEY = originalPollinationsKey;
    }
  }

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
// Test 3 — Explicit Memory Storage
// ─────────────────────────────

async function testMemoryStorage(): Promise<OrchestratorResponse> {
  section("Memory Storage");

  const res: OrchestratorResponse = await orchestrate({
    userMessage: "My name is Soumo. Remember it.",
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
    userMessage: "What's my name you remember?",
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
    replyLower.includes("soumo"),
    "Reply references stored identity memory (Soumo)",
    `reply snippet: "${(res.reply ?? "").slice(0, 120)}"`,
  );
}

async function testExplicitMemoryPhrasings(): Promise<void> {
  section("Explicit Memory Phrasings");

  const prompts = [
    "Remember my name is Soumo.",
    "Don't forget that my name is Soumo.",
  ];

  for (const prompt of prompts) {
    const res: OrchestratorResponse = await orchestrate({ userMessage: prompt });
    assert(res.memory.stored === true, `Memory stored for phrasing: "${prompt}"`, `stored: ${res.memory.stored}`);
  }
}

// ─────────────────────────────
// Test 5 — Chart Generation
// ─────────────────────────────

async function testChartGeneration(): Promise<void> {
  section("Chart Generation");

  const res: OrchestratorResponse = await orchestrate({
    userMessage: "Generate a scatter plot with 500 points using a Gaussian distribution.",
  });

  console.log(`  route: ${res.route}  |  chart success: ${res.chart?.success}  |  renderer: ${res.chart?.renderer ?? "none"}`);

  assert(res.route === "chart_generation", "Route is chart_generation", `got: ${res.route}`);
  assert(!!res.chart, "Chart payload present");
  if (res.chart) {
    const supportedRenderers: readonly RendererType[] = ["matplotlib", "plotly", "chartjs"];
    assert(res.chart.success === true, "Chart generation succeeded");
    assert(!!res.chart.code && res.chart.code.length > 50, "Code is non-trivial", `length: ${res.chart.code.length}`);
    assert(res.chart.chart_type === "scatter", "Chart type is scatter", `got: ${res.chart.chart_type}`);
    assert(
      supportedRenderers.includes(res.chart.renderer as RendererType),
      "Renderer is supported",
      `got: ${res.chart.renderer}`,
    );
    if (res.chart.renderer === "chartjs") {
      assert(!!res.chart.chartjs_config, "Chart.js config is present for frontend-native renderer");
      assert(/mulberry32|seededRandom|gaussianRandom/.test(res.chart.code), "Chart.js code uses seeded deterministic generation");
    } else if (res.chart.renderer === "plotly") {
      assert(!!res.chart.plotly_json, "Plotly JSON is present for Plotly renderer");
    } else {
      assert(
        res.chart.code.includes("np.random.seed") || res.chart.code.includes("np.random"),
        "Matplotlib code uses numpy random",
      );
    }
  }
}

async function run(): Promise<void> {
  console.log("\n🔬 SentIQ Chat Integration Test Pipeline");
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

  try {
    await testExplicitMemoryPhrasings();
  } catch (err) {
    console.log(`  ${FAIL}  Explicit memory phrasing test threw: ${err instanceof Error ? err.message : err}`);
    failed++;
  }

  try {
    await testChartGeneration();
  } catch (err) {
    console.log(`  ${FAIL}  Test 5 threw: ${err instanceof Error ? err.message : err}`);
    failed++;
  }

  // Test 5 removed (web search pipeline removed)

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS:  ${passed} passed  /  ${failed} failed  (${elapsed}s)`);
  console.log(`${"═".repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
