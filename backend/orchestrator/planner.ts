// SentIQGPT v2 — Task Planner
//
// Analyzes a user query and produces a structured execution plan
// of 1–3 steps. Uses Groq (route_classify) for fast classification.
//
// For simple single-tool requests the plan has a single step,
// keeping latency identical to the old tool-detector path.
// For compound requests ("generate an image and explain the concept")
// it produces multiple ordered steps.
//
// Safety constraints:
//   • Max 3 steps per plan
//   • Only permitted tools: conversation, image_generation,
//     file_analysis, memory_update
//   • No recursive/self-referencing steps

import {
  callLLMAdapter,
  getDemoFallbackResponse,
  strictParseJsonObject,
} from "../ai/PromptBuilders";
import type { LLMAdapterCall } from "../ai/PromptBuilders";
import { isChartRequest } from "../tools/chartGeneration/chartDetector";

// ==============================
// Types
// ==============================

export type PlanTool =
  | "conversation"
  | "image_generation"
  | "file_analysis"
  | "memory_update"
  | "chart_generation";

const VALID_PLAN_TOOLS: ReadonlySet<string> = new Set<PlanTool>([
  "conversation",
  "image_generation",
  "file_analysis",
  "memory_update",
  "chart_generation",
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

// ==============================
// Prompt
// ==============================

function buildPlannerPrompt(
  userMessage: string,
  hasFileContext: boolean,
): LLMAdapterCall {
  const prompt =
    "TASK: Execution Planning\n" +
    "ROLE: Break down the user's request into an ordered execution plan.\n\n" +
    "AVAILABLE TOOLS:\n" +
    '- "conversation": Answer questions, explain concepts, provide analysis\n' +
    '- "image_generation": Generate an image from a text description\n' +
    '- "file_analysis": Analyze uploaded file content' +
    (hasFileContext ? " (files ARE in context)" : " (NO files in context — do NOT select this)") +
    "\n" +
    '- "memory_update": Store a personal fact the user wants remembered\n' +
    '- "chart_generation": Generate a chart or data visualization (scatter, bar, histogram, heatmap, etc.)\n\n' +
    "RULES:\n" +
    "- Return 1 to 3 steps maximum.\n" +
    "- Most requests need only 1 step — keep it simple.\n" +
    "- Use multiple steps ONLY when the user explicitly asks for more than one action.\n" +
    "  Example multi-step: \"Generate an image of a cat and explain cat breeds.\"\n" +
    "  Example single-step: \"What is quantum computing?\" → 1 step (conversation).\n" +
    "- Each step must have a clear, self-contained input string.\n" +
    "- Only choose image_generation if the user EXPLICITLY asks to create/generate an image.\n" +
    "- Only choose chart_generation if the user asks for a chart, graph, plot, or data visualization.\n" +
    "- Only choose file_analysis if uploaded files exist in context.\n" +
    "- Only choose memory_update when the user says remember/forget.\n" +
    "- Default truly ambiguous requests to a single conversation step.\n" +
    "- Steps run in order. Later steps may use results of earlier ones.\n\n" +
    "USER MESSAGE:\n" +
    userMessage +
    "\n\nRETURN JSON (array of steps):\n" +
    '{ "plan": [\n' +
    '  { "step": 1, "tool": "conversation"|"image_generation"|"file_analysis"|"memory_update"|"chart_generation", "input": "..." }\n' +
    "] }";

  return {
    task: "route_classify",
    prompt,
    prefer: "groq",
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
}): Promise<ExecutionPlan> {
  // Hard safety rule: chart keywords ALWAYS produce a single chart_generation step.
  // This pre-check bypasses the LLM entirely and guarantees chart requests
  // are never accidentally routed to image_generation in multi-step plans.
  if (isChartRequest(args.userMessage)) {
    console.log(`[PLANNER] chart keywords detected — hard-routing to chart_generation`);
    return {
      steps: [{ step: 1, tool: "chart_generation", input: args.userMessage }],
    };
  }

  const call = buildPlannerPrompt(
    args.userMessage,
    args.hasFileContext ?? false,
  );

  let raw: string;
  try {
    raw = await callLLMAdapter(call);
  } catch {
    raw = getDemoFallbackResponse("route_classify");
  }

  try {
    const plan = parsePlan(raw);

    // Guarantee at least one step
    if (plan.steps.length === 0) {
      return {
        steps: [{ step: 1, tool: "conversation", input: args.userMessage }],
      };
    }

    console.log(`[PLANNER] steps generated: ${plan.steps.length}`);
    for (const s of plan.steps) {
      console.log(`[PLANNER]   step ${s.step}: ${s.tool} → "${s.input.slice(0, 60)}"`);
    }

    return plan;
  } catch {
    console.log(`[PLANNER] parse failed, fallback: single conversation step`);
    return {
      steps: [{ step: 1, tool: "conversation", input: args.userMessage }],
    };
  }
}
