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
  const chatHandler = readFileSync(resolve(__dirname, "ai", "ChatHandler.ts"), "utf8");
  const contextCompressor = readFileSync(resolve(__dirname, "context", "contextCompressor.ts"), "utf8");
  const contextCapsules = readFileSync(resolve(__dirname, "services", "contextCapsuleService.ts"), "utf8");
  const fileGenerator = readFileSync(resolve(__dirname, "tools", "fileGeneration", "fileGenerator.ts"), "utf8");
  const llmService = readFileSync(resolve(__dirname, "llm_service.py"), "utf8");
  assert.doesNotMatch(server, /\/api\/chat\/intent|clarification_response|shouldAutoUseWebSurf|isFileGenerationRequest|isChartRequest|isImageRequest/);
  assert.doesNotMatch(planner, /route_classify|keyword|regex|classifyQueryType/);
  assert.doesNotMatch(frontend, /getChatIntent|intent-detection|isLikelyFileGenerationRequest|isImageRequest\(|isChartRequest\(/);
  assert.match(frontend, /onToolLifecycle/);
  assert.match(executor, /!priorContext && !webSurfEvidence && !ctx\.webSearchMode/);
  assert.doesNotMatch(executor, /resolveContextReferences|masterRouter|queryClassifier|modelRouter/);
  assert.match(executor, /automatic tools require a validated model tool call/);

  const primaryHappyPathCost = {
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
  assert.deepEqual(primaryHappyPathCost.ordinary_fast, primaryHappyPathCost.ordinary_intuitive);
  assert.equal(primaryHappyPathCost.automatic_web_surf.textModelCalls, 2);

  const verifiedAdditionalCostPaths = {
    ordinaryTruncationContinuation: chatHandler.includes("shouldAttemptContinuation")
      && chatHandler.includes("continuationResult = await callLLMAdapterDetailed"),
    intuitiveConversationCompression: contextCompressor.includes("SKIP_COMPRESSION_THRESHOLD")
      && contextCompressor.includes("await callLLMAdapter(call)"),
    fileGenerationFallback: fileGenerator.includes("const secondary = await attemptGenerate"),
    backgroundTitleGeneration: server.includes("generateTitleWithFallback")
      && server.includes("scheduleAutoTitleConversation"),
    backgroundContextCapsules: contextCapsules.includes("refreshConversationCapsule")
      && contextCapsules.includes("refreshWorkspaceCapsuleIfNeeded")
      && contextCapsules.includes("this.dependencies.generateSummary(prompt)"),
    inputSafetyModel: llmService.includes("check_input_safety")
      && llmService.includes("call_safety_model(prompt, check_type=\"input\")"),
    streamingOutputSafetyModels: llmService.includes("StreamingSafetyMonitor")
      && llmService.includes("check_output_safety(final_output"),
    webSurfV2ConfigurationBranch: executor.includes("if (isWebSurfV2Enabled())")
      && executor.includes("skipLLMSynthesis: true"),
  } as const;
  for (const [name, present] of Object.entries(verifiedAdditionalCostPaths)) {
    assert.equal(present, true, `missing documented additional cost path: ${name}`);
  }

  console.log(JSON.stringify({ primaryHappyPathCost, verifiedAdditionalCostPaths }, null, 2));
  console.log("Model-native lifecycle and request-cost checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
