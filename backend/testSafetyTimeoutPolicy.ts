import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const promptBuilders = readFileSync(join(root, "backend", "ai", "PromptBuilders.ts"), "utf8");
const chatHandler = readFileSync(join(root, "backend", "ai", "ChatHandler.ts"), "utf8");
const llmService = readFileSync(join(root, "backend", "llm_service.py"), "utf8");
const fileGenerator = readFileSync(join(root, "backend", "tools", "fileGeneration", "fileGenerator.ts"), "utf8");
const webSearchPipeline = readFileSync(join(root, "backend", "tools", "webSearch", "tavilySearchPipeline.ts"), "utf8");

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function functionSlice(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${startNeedle} should exist`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${endNeedle} should follow ${startNeedle}`);
  return source.slice(start, end);
}

{
  assert(promptBuilders.includes('readonly safety_mode?: "low_risk_text"'), "LLM adapter call type should expose internal safety mode");
  assert(count(promptBuilders, "safety_mode: call.safety_mode") >= 2, "invoke and stream bridge should forward safety_mode to Python");
  assert(
    promptBuilders.includes('const safetyMode = !hasFiles && !hasImages ? "low_risk_text" : undefined;'),
    "chat prompt should only mark no-file/no-image text as low-risk",
  );
  assert(promptBuilders.includes("safety_mode: safetyMode"), "chat prompt should pass computed safety mode");
  assert(promptBuilders.includes('safety_mode: "low_risk_text"'), "title generation should use low-risk safety mode");
  console.log("PASS | Node adapter forwards low-risk safety mode only for eligible text/title calls");
}

{
  const memoryClassify = functionSlice(
    promptBuilders,
    "export function buildMemoryClassifyPrompt",
    "// ==============================\n// Memory summarization prompt",
  );
  const memorySummarize = functionSlice(
    promptBuilders,
    "export function buildMemorySummarizePrompt",
    "// ==============================\n// Memory compression prompt",
  );
  const memoryCompress = functionSlice(
    promptBuilders,
    "export function buildMemoryCompressPrompt",
    "// ==============================\n// Session title generation prompt",
  );
  assert(!memoryClassify.includes("safety_mode"), "memory classification should remain strict");
  assert(!memorySummarize.includes("safety_mode"), "memory summarization should remain strict");
  assert(!memoryCompress.includes("safety_mode"), "memory compression should remain strict");
  assert(!fileGenerator.includes("safety_mode"), "file generation should remain strict");
  assert(!webSearchPipeline.includes("safety_mode"), "web search synthesis should remain strict");
  console.log("PASS | tool/file/memory/web adapter calls remain strict");
}

{
  assert(llmService.includes('SAFETY_MODE_LOW_RISK_TEXT = "low_risk_text"'), "Python gateway should define low-risk safety mode");
  assert(llmService.includes("safety.input.timeout.allow_degraded"), "Python gateway should log degraded-open input timeouts");
  assert(llmService.includes("safety.input.blocked.explicit"), "Python gateway should log explicit input blocks");
  assert(llmService.includes("safety.output.timeout.degraded"), "Python gateway should log output safety timeout degradation");
  assert(llmService.includes("classification in DEGRADED_SAFETY_CLASSIFICATIONS"), "Python gateway should distinguish degraded safety from unsafe");
  assert(llmService.includes("return True, classification, raw_response"), "Python gateway should allow selected degraded safety paths");
  console.log("PASS | Python gateway source contains explicit degraded safety policy");
}

{
  const oldGeneric = "I'm currently unable to process your request. Please try again shortly.";
  assert(!promptBuilders.includes(`reply: "${oldGeneric}"`), "chat demo fallback should not surface the old generic failure reply");
  assert(!chatHandler.includes(`const RAW_REASONING_FALLBACK =\n  "${oldGeneric}"`), "reasoning fallback should not use the old generic failure reply");
  assert(promptBuilders.includes("I couldn't complete that response. Please retry in a moment."), "new fallback copy should be present");
  console.log("PASS | old generic fallback copy is not used as the backend fallback response");
}

console.log("\nSafety timeout static validation passed.");
