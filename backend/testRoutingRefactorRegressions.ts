import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { resolveHardRoutedPlan } from "./orchestrator/planner";
import {
  classifyQueryType,
  isImagePromptWritingRequest,
  shouldAutoUseWebSurf,
} from "./orchestrator/queryClassifier";
import { isImageRequest as isBackendImageRequest } from "./middleware/imageQuota";
import {
  detectGeneratedFileFormat,
  isFileGenerationRequest,
} from "./tools/fileGeneration/fileDetector";
import { detectChartIntent, isChartRequest } from "./tools/chartGeneration/chartDetector";
import { routeChartGeneration } from "./tools/chartGeneration/chartRouter";

function firstChartJsDatasetData(chartjsConfig: unknown): unknown {
  return (chartjsConfig as any)?.data?.datasets?.[0]?.data;
}

function chartJsLabels(chartjsConfig: unknown): unknown {
  return (chartjsConfig as any)?.data?.labels;
}

function ensureTestSupabaseEnv(): void {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= `https://db${id}.example.supabase.co`;
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
}

async function main(): Promise<void> {
  process.env.TAVILY_KEYS = "test-key";

  const currentPrompt = "The latest news about AMD";
  assert.equal(shouldAutoUseWebSurf(currentPrompt), true, "latest AMD news is clearly current/live");
  assert.equal(classifyQueryType(currentPrompt).needsWebSearch, true, "latest AMD news needs web search");
  assert.equal(
    resolveHardRoutedPlan({ userMessage: currentPrompt, hasWebSearch: true })?.steps[0]?.tool,
    "web_search",
    "latest AMD news hard-routes to web_search",
  );

  const sportsPrompt = "IPL results 2026 latest";
  assert.equal(shouldAutoUseWebSurf(sportsPrompt), true, "IPL latest results are current/live");
  assert.equal(
    resolveHardRoutedPlan({ userMessage: sportsPrompt, hasWebSearch: true })?.steps[0]?.tool,
    "web_search",
    "IPL latest results hard-route to web_search",
  );

  const serverSource = readFileSync(pathResolve(__dirname, "server.ts"), "utf8");
  const toolExecutorSource = readFileSync(pathResolve(__dirname, "orchestrator", "toolExecutor.ts"), "utf8");
  assert.match(serverSource, /shouldAutoUseWebSurf\(effectiveUserMessage\)/, "server computes auto WebSurf routing");
  assert.match(serverSource, /hasEffectiveWebSearchMode && !isFileGenerationRequest/, "stream redirects explicit or auto WebSurf");
  assert.match(serverSource, /!hasEffectiveWebSearchMode &&/, "Fast stream bypass excludes auto WebSurf prompts");
  assert.match(serverSource, /"fallback_reason"/, "public response sanitizer strips fallback_reason");
  assert.match(toolExecutorSource, /safeImageGenerationFailureMessage/, "image generation failure replies are public-safe");
  assert.match(toolExecutorSource, /safeWebSearchFailureMessage/, "web search failure replies are public-safe");

  const imagePrompt = "Show me a goose bird";
  assert.equal(classifyQueryType(imagePrompt).category, "image_generation", "goose visual request is image generation");
  assert.equal(isBackendImageRequest(imagePrompt), true, "backend image request detector catches goose visual request");
  assert.equal(
    resolveHardRoutedPlan({ userMessage: imagePrompt, hasWebSearch: true })?.steps[0]?.tool,
    "image_generation",
    "goose visual request hard-routes to image_generation",
  );

  const promptWriting = "Generate image: Write me a prompt to generate a good rose image";
  assert.equal(isImagePromptWritingRequest(promptWriting), true, "image prompt-writing request is recognized");
  assert.notEqual(classifyQueryType(promptWriting).category, "image_generation", "image prompt-writing stays text");
  assert.equal(isBackendImageRequest(promptWriting), false, "backend image request detector ignores prompt-writing");
  assert.notEqual(
    resolveHardRoutedPlan({ userMessage: promptWriting, hasWebSearch: true })?.steps[0]?.tool,
    "image_generation",
    "prompt-writing request does not hard-route to image_generation",
  );

  const chartPrompt = "Create a bar chart comparing 10, 20, and 30";
  assert.equal(isChartRequest(chartPrompt), true, "bar chart prompt is chart_generation");
  assert.deepEqual(
    detectChartIntent(chartPrompt).parameters.values,
    [10, 20, 30],
    "bar chart prompt extracts inline values",
  );
  const chartResult = await routeChartGeneration({ userMessage: chartPrompt });
  assert.equal(chartResult.success, true, "bar chart generation succeeds");
  assert.deepEqual(
    firstChartJsDatasetData(chartResult.chartjs_config),
    [10, 20, 30],
    "bar chart uses requested values",
  );
  assert.deepEqual(
    chartJsLabels(chartResult.chartjs_config),
    ["Item 1", "Item 2", "Item 3"],
    "bar chart labels match requested value count",
  );
  assert.match(toolExecutorSource, /Generated chart\./, "chart executor has a success reply");

  ensureTestSupabaseEnv();
  const { orchestrate } = await import("./orchestrator/aiOrchestrator");
  const orchestratedChart = await orchestrate({
    userMessage: chartPrompt,
    executionMode: "fast",
    context: { userId: "routing-regression-test" },
  });
  assert.equal(orchestratedChart.route, "chart_generation", "orchestrator keeps chart route");
  assert.equal(orchestratedChart.chart?.success, true, "orchestrator returns successful chart payload");
  assert(!/sorry, something went wrong/i.test(orchestratedChart.reply ?? ""), "chart reply avoids generic failure text");
  assert.deepEqual(
    firstChartJsDatasetData(orchestratedChart.chart?.chartjs_config),
    [10, 20, 30],
    "orchestrator chart payload uses requested values",
  );

  const filePrompt = "Create a downloadable HTML file for a simple portfolio page";
  assert.equal(detectGeneratedFileFormat(filePrompt), "html", "downloadable HTML file resolves html format");
  assert.equal(isFileGenerationRequest(filePrompt), true, "downloadable HTML file is file_generation");
  assert.equal(
    resolveHardRoutedPlan({ userMessage: filePrompt, hasWebSearch: true })?.steps[0]?.tool,
    "file_generation",
    "downloadable HTML file hard-routes to file_generation",
  );

  console.log("Routing refactor regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
