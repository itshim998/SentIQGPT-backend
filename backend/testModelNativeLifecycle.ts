import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { planTask } from "./orchestrator/planner";

const ordinaryPrompts = [
  "Explain how the word latest functions in this sentence.",
  "Show me how to code an HTML image element.",
  "Discuss image generation safety.",
  "Explain how web search works.",
  "Create a class named WebSearch in TypeScript.",
  "Discuss the phrase generate image.",
  "Help me visualize the argument metaphorically.",
  "Generate three paragraphs of text.",
];

async function main(): Promise<void> {
  for (const prompt of ordinaryPrompts) {
    const plan = await planTask({ userMessage: prompt, executionMode: "fast" });
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0]?.tool, "conversation", prompt);
  }

  const intuitive = await planTask({ userMessage: "Which Jordan do you mean?", executionMode: "intuitive" });
  assert.equal(intuitive.steps[0]?.tool, "conversation");
  const manualWeb = await planTask({ userMessage: "Find the source", explicitWebSearchMode: "basic" });
  assert.equal(manualWeb.steps[0]?.tool, "web_search");

  const server = readFileSync(resolve(__dirname, "server.ts"), "utf8");
  const planner = readFileSync(resolve(__dirname, "orchestrator", "planner.ts"), "utf8");
  const frontend = readFileSync(resolve(__dirname, "..", "frontend", "scripts", "features", "chat-controller.js"), "utf8");
  const executor = readFileSync(resolve(__dirname, "orchestrator", "toolExecutor.ts"), "utf8");
  assert.doesNotMatch(server, /\/api\/chat\/intent|clarification_response|shouldAutoUseWebSurf|isFileGenerationRequest|isChartRequest|isImageRequest/);
  assert.doesNotMatch(planner, /route_classify|keyword|regex|classifyQueryType/);
  assert.doesNotMatch(frontend, /getChatIntent|intent-detection|isLikelyFileGenerationRequest|isImageRequest\(|isChartRequest\(/);
  assert.match(frontend, /onToolLifecycle/);
  assert.match(executor, /!priorContext && !webSurfEvidence && !ctx\.webSearchMode/);
  assert.doesNotMatch(executor, /resolveContextReferences|masterRouter|queryClassifier|modelRouter/);
  assert.match(executor, /automatic tools require a validated model tool call/);

  const cost = {
    ordinary_fast: { textModelCalls: 1, toolCalls: 0 },
    ordinary_intuitive: { textModelCalls: 1, toolCalls: 0 },
    automatic_web_surf: { textModelCalls: 2, toolCalls: 1 },
    automatic_image: { textModelCalls: 1, toolCalls: 1 },
    automatic_chart: { textModelCalls: 1, toolCalls: 1 },
    automatic_file: { textModelCalls: 2, toolCalls: 1 },
    automatic_memory: { textModelCalls: 1, toolCalls: 1 },
    manual_web_surf: { textModelCalls: 1, toolCalls: 1 },
    manual_image: { textModelCalls: 0, toolCalls: 1 },
    clarification: { textModelCalls: 1, toolCalls: 0 },
  } as const;
  assert.deepEqual(cost.ordinary_fast, cost.ordinary_intuitive);
  assert.equal(cost.automatic_web_surf.textModelCalls, 2);
  console.log(JSON.stringify(cost, null, 2));
  console.log("Model-native lifecycle and request-cost checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
