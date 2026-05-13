// SentIQGPT v2 - Task Planner
//
// Analyzes a user query and produces a structured execution plan
// of 1-3 steps. Uses Groq (route_classify) for fast classification.
//
// For simple single-tool requests the plan has a single step,
// keeping latency identical to the old tool-detector path.
// For compound requests ("generate an image and explain the concept")
// it produces multiple ordered steps.
//
// Safety constraints:
//   - Max 3 steps per plan
//   - Only permitted tools: conversation, image_generation,
//     file_analysis, memory_update, chart_generation, web_search
//   - No recursive/self-referencing steps

import {
  callLLMAdapter,
  getDemoFallbackResponse,
  strictParseJsonObject,
} from "../ai/PromptBuilders";
import type { LLMAdapterCall } from "../ai/PromptBuilders";
import { isChartRequest } from "../tools/chartGeneration/chartDetector";
import { isFileGenerationRequest, isImpliedFileGenerationRequest } from "../tools/fileGeneration/fileDetector";
import type { WebSearchMode } from "../tools/webSearch/webSearchMode";
import { isTavilyAvailable } from "../tools/webSearch/providers/tavilyProvider";
import { classifyQueryType, shouldForceWebSearch } from "./queryClassifier";

// ==============================
// Types
// ==============================

export type PlanTool =
  | "conversation"
  | "image_generation"
  | "file_analysis"
  | "memory_update"
  | "chart_generation"
  | "file_generation"
  | "web_search";

const VALID_PLAN_TOOLS: ReadonlySet<string> = new Set<PlanTool>([
  "conversation",
  "image_generation",
  "file_analysis",
  "memory_update",
  "chart_generation",
  "file_generation",
  "web_search",
]);

const MAX_STEPS = 3;

export interface PlanStep {
  readonly step: number;
  readonly tool: PlanTool;
  readonly input: string;
}

export interface ExecutionPlan {
  readonly steps: readonly PlanStep[];
}

function createSingleStepPlan(tool: PlanTool, input: string): ExecutionPlan {
  return {
    steps: [{ step: 1, tool, input }],
  };
}

// ==============================
// Prompt
// ==============================

function buildPlannerPrompt(
  userMessage: string,
  hasFileContext: boolean,
  hasWebSearch: boolean,
  userId?: string,
): LLMAdapterCall {
  const webSearchTool = hasWebSearch
    ? '- "web_search": Search the web for current information, news, real-time data, or facts that may be outdated in training data\n'
    : "";

  const prompt =
    "TASK: Execution Planning\n" +
    "ROLE: Break down the user's request into an ordered execution plan.\n\n" +
    "AVAILABLE TOOLS:\n" +
    '- "conversation": Answer questions, explain concepts, provide analysis\n' +
    '- "image_generation": Generate an image from a text description\n' +
    '- "file_analysis": Analyze uploaded file content' +
    (hasFileContext ? " (files ARE in context)" : " (NO files in context - do NOT select this)") +
    "\n" +
    '- "memory_update": Store a personal fact the user wants remembered\n' +
    '- "chart_generation": Generate a chart or data visualization (scatter, bar, histogram, heatmap, etc.)\n' +
    '- "file_generation": Generate a downloadable .pdf, .docx, .pptx, .xlsx, .html, or .txt file\n' +
    webSearchTool +
    "\nRULES:\n" +
    "- Return 1 to 3 steps maximum.\n" +
    "- Most requests need only 1 step - keep it simple.\n" +
    "- Use multiple steps ONLY when the user explicitly asks for more than one action.\n" +
    '  Example multi-step: "Generate an image of a cat and explain cat breeds."\n' +
    '  Example single-step: "What is quantum computing?" -> 1 step (conversation).\n' +
    "- Each step must have a clear, self-contained input string.\n" +
    "- Only choose image_generation if the user EXPLICITLY asks to create/generate an image.\n" +
    "- Only choose chart_generation for an explicit chart or data-visualization request, not for frontend/design prompts that merely mention visualization.\n" +
    "- Only choose file_generation when the user explicitly asks to create/export a downloadable file in a supported format.\n" +
    "- Only choose file_analysis if uploaded files exist in context.\n" +
    "- Only choose memory_update when the user explicitly asks you to remember, save, store, or keep something in mind.\n" +
    (hasWebSearch
      ? '- Choose "web_search" for questions about current events, recent news, real-time data (stock prices, weather, scores), facts that may have changed since training data cutoff (e.g., "best AI models in 2026"), or when the user asks to "search" or "look up".\n'
      : "") +
    "- Default truly ambiguous requests to a single conversation step.\n" +
    "- Steps run in order. Later steps may use results of earlier ones.\n\n" +
    "USER MESSAGE:\n" +
    userMessage +
    "\n\nRETURN JSON (array of steps):\n" +
    '{ "plan": [\n' +
    '  { "step": 1, "tool": "conversation"|"image_generation"|"file_analysis"|"memory_update"|"chart_generation"|"file_generation"' +
    (hasWebSearch ? '|"web_search"' : "") +
    ', "input": "..." }\n' +
    "] }";

  return {
    task: "route_classify",
    prompt,
    prefer: "groq",
    user_id: userId,
  };
}

// ==============================
// Parser
// ==============================

function parsePlan(raw: string): ExecutionPlan {
  const parsed = strictParseJsonObject(raw);
  const rawPlan = Array.isArray(parsed.plan) ? parsed.plan : [];
  const steps: PlanStep[] = [];

  for (const item of rawPlan) {
    if (steps.length >= MAX_STEPS) break;

    const input =
      typeof item.input === "string" && item.input.trim()
        ? item.input.trim()
        : "";

    if (!input) continue;

    const parsedTool =
      typeof item.tool === "string" && VALID_PLAN_TOOLS.has(item.tool)
        ? (item.tool as PlanTool)
        : "conversation";

    // Secondary safety: if the LLM incorrectly assigned image_generation for a
    // chart-like message, override to chart_generation.
    const safeTool: PlanTool = (parsedTool === "image_generation" && isChartRequest(input))
      ? "chart_generation"
      : parsedTool;

    steps.push({
      step: steps.length + 1,
      tool: safeTool,
      input,
    });
  }

  return { steps };
}

export function resolveHardRoutedPlan(args: {
  readonly userMessage: string;
  readonly hasWebSearch: boolean;
  readonly explicitWebSearchMode?: WebSearchMode;
}): ExecutionPlan | null {
  if (isFileGenerationRequest(args.userMessage)) {
    console.log("[PLANNER] file generation detected - hard-routing to file_generation");
    return createSingleStepPlan("file_generation", args.userMessage);
  }

  if (isImpliedFileGenerationRequest(args.userMessage)) {
    console.log("[PLANNER] implied file intent without explicit format - keeping as conversation");
    return createSingleStepPlan("conversation", args.userMessage);
  }

  if (args.hasWebSearch && args.explicitWebSearchMode) {
    console.log(`[PLANNER] explicit WebSurf mode=${args.explicitWebSearchMode} - hard-routing to web_search`);
    return createSingleStepPlan("web_search", args.userMessage);
  }

  if (isChartRequest(args.userMessage)) {
    console.log("[PLANNER] chart keywords detected - hard-routing to chart_generation");
    return createSingleStepPlan("chart_generation", args.userMessage);
  }

  const queryClassification = classifyQueryType(args.userMessage);
  if (queryClassification.category === "image_generation") {
    console.log(`[PLANNER] image request detected (rule: ${queryClassification.matchedRule}) - hard-routing to image_generation`);
    return createSingleStepPlan("image_generation", args.userMessage);
  }

  const forceWebSearch = shouldForceWebSearch(args.userMessage);

  if (args.hasWebSearch && (queryClassification.needsWebSearch || forceWebSearch)) {
    console.log(`[PLANNER] web search needed (rule: ${queryClassification.matchedRule}) - hard-routing to web_search`);
    return createSingleStepPlan("web_search", args.userMessage);
  }

  return null;
}

// ==============================
// Public API
// ==============================

/**
 * Generate an execution plan for the user's message.
 *
 * Falls back to a single "conversation" step on any error,
 * ensuring the user always gets a response.
 */
export async function planTask(args: {
  readonly userMessage: string;
  readonly hasFileContext?: boolean;
  readonly userId?: string;
  readonly explicitWebSearchMode?: WebSearchMode;
}): Promise<ExecutionPlan> {
  const hasWebSearch = isTavilyAvailable();
  const hardRoutedPlan = resolveHardRoutedPlan({
    userMessage: args.userMessage,
    hasWebSearch,
    explicitWebSearchMode: args.explicitWebSearchMode,
  });
  if (hardRoutedPlan) {
    return hardRoutedPlan;
  }

  const call = buildPlannerPrompt(
    args.userMessage,
    args.hasFileContext ?? false,
    hasWebSearch,
    args.userId,
  );

  let raw: string;
  try {
    raw = await callLLMAdapter(call);
  } catch {
    raw = getDemoFallbackResponse("route_classify");
  }

  try {
    const plan = parsePlan(raw);

    if (plan.steps.length === 0) {
      return createSingleStepPlan("conversation", args.userMessage);
    }

    console.log(`[PLANNER] steps generated: ${plan.steps.length}`);
    for (const step of plan.steps) {
      console.log(`[PLANNER]   step ${step.step}: ${step.tool} -> "${step.input.slice(0, 60)}"`);
    }

    return plan;
  } catch {
    console.log("[PLANNER] parse failed, fallback: single conversation step");
    return createSingleStepPlan("conversation", args.userMessage);
  }
}
