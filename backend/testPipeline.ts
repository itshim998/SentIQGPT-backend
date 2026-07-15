// SentIQ Chat offline integration pipeline.
//
// Automatic model tools are deliberately default-off. This suite verifies
// that ordinary keyword-shaped prompts do not revive the retired keyword
// router or execute image, chart, or memory tools while those flags are off.

import * as dotenv from "dotenv";
import type { OrchestratorResponse } from "./orchestrator/aiOrchestrator";

dotenv.config();

const automaticToolFlags = [
  "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
  "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
] as const;

for (const flag of automaticToolFlags) {
  process.env[flag] = "false";
}

// Load the orchestrator only after the deterministic default-off environment
// is installed; several capability flags are read when modules initialize.
const { orchestrate } = require("./orchestrator/aiOrchestrator") as typeof import("./orchestrator/aiOrchestrator");

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
    passed += 1;
    return;
  }
  console.log(`  ${FAIL}  ${label}${detail ? ` - ${detail}` : ""}`);
  failed += 1;
}

function section(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  TEST: ${title}`);
  console.log("=".repeat(60));
}

async function testNormalConversation(): Promise<void> {
  section("Normal Conversation");
  const response: OrchestratorResponse = await orchestrate({
    userMessage: "Explain what a neural network is.",
  });

  assert(
    response.route === "normal_chat" || response.route === "knowledge_query",
    "Ordinary text remains on a text route",
    `route: ${response.route}`,
  );
  assert(Boolean(response.reply), "Text route returns a public-safe reply");
  assert((response.answer ?? response.reply) === response.reply, "Structured answer mirrors the public reply");
  assert(!/<think>/i.test(response.reply ?? ""), "Public reply does not leak thinking tags");
  assert(response.memory.stored === false, "Ordinary text does not store memory");
  assert(typeof response.confidence === "number" && response.confidence > 0, "Confidence remains populated");
}

async function testImageKeywordDoesNotRoute(): Promise<void> {
  section("Image Selection Disabled By Default");
  const response: OrchestratorResponse = await orchestrate({
    userMessage: "Generate an image of a futuristic cyberpunk city at night.",
  });

  assert(response.route !== "image_generation", "Image keywords do not revive automatic routing", `route: ${response.route}`);
  assert(!response.image, "No image provider payload is produced");
}

async function testMemoryKeywordsDoNotRoute(): Promise<void> {
  section("Memory Selection Disabled By Default");
  const prompts = [
    "My name is Soumo. Remember it.",
    "Remember my name is Soumo.",
    "Don't forget that my name is Soumo.",
  ];

  for (const prompt of prompts) {
    const response: OrchestratorResponse = await orchestrate({ userMessage: prompt });
    assert(response.route !== "memory_update", `No keyword memory route for: ${prompt}`, `route: ${response.route}`);
    assert(response.memory.stored === false, `No automatic memory write for: ${prompt}`);
  }
}

async function testChartKeywordDoesNotRoute(): Promise<void> {
  section("Chart Selection Disabled By Default");
  const response: OrchestratorResponse = await orchestrate({
    userMessage: "Generate a scatter plot with 500 points using a Gaussian distribution.",
  });

  assert(response.route !== "chart_generation", "Chart keywords do not revive automatic routing", `route: ${response.route}`);
  assert(!response.chart, "No chart tool payload is produced");
}

async function runCase(label: string, test: () => Promise<void>): Promise<void> {
  try {
    await test();
  } catch (error) {
    console.log(`  ${FAIL}  ${label} threw: ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
}

async function run(): Promise<void> {
  console.log("\nSentIQ Chat Offline Integration Pipeline");
  console.log("-".repeat(60));
  const startedAt = Date.now();

  await runCase("Normal conversation", testNormalConversation);
  await runCase("Image default-off", testImageKeywordDoesNotRoute);
  await runCase("Memory default-off", testMemoryKeywordsDoNotRoute);
  await runCase("Chart default-off", testChartKeywordDoesNotRoute);

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  RESULTS: ${passed} passed / ${failed} failed (${elapsedSeconds}s)`);
  console.log(`${"=".repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void run();
