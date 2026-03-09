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

// ==============================
// Types
// ==============================

export type PlanTool =
  | "conversation"
  | "image_generation"
  | "file_analysis"
  | "memory_update"
  | "web_search";

const VALID_PLAN_TOOLS: ReadonlySet<string> = new Set<PlanTool>([
  "conversation",
  "image_generation",
  "file_analysis",
  "memory_update",
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
    '- "web_search": Search the web for current/recent information, news, facts, or anything the AI does not know\n\n' +
    "RULES:\n" +
    "- Return 1 to 3 steps maximum.\n" +
    "- Most requests need only 1 step — keep it simple.\n" +
    "- Use multiple steps ONLY when the user explicitly asks for more than one action.\n" +
    "  Example multi-step: \"Generate an image of a cat and explain cat breeds.\"\n" +
    "  Example single-step: \"What is quantum computing?\" → 1 step (conversation).\n" +
    "- Each step must have a clear, self-contained input string.\n" +
    "- Only choose image_generation if the user EXPLICITLY asks to create/generate an image.\n" +
    "- Only choose file_analysis if uploaded files exist in context.\n" +
    "- Only choose memory_update when the user says remember/forget.\n" +
    "- Choose web_search when the user asks about:\n" +
    "    • Current events, latest news, recent updates, today\'s information, real-time data\n" +
    "    • Sports: scores, tournaments, world cups, match results, standings, IPL, T20, Olympics\n" +
    "    • Medicines, drugs, supplements, health products, or any pharmaceutical name\n" +
    "    • Products, prices, releases, reviews, specifications, comparisons\n" +
    "    • Companies, brands, people, or any proper noun / named entity you are unsure about\n" +
    "    • Technical documentation, APIs, libraries, frameworks\n" +
    "    • Population, GDP, statistics, or any fact that may have changed recently\n" +
    "    • Anything you are NOT 100% confident exists in your training data\n" +
    "- IMPORTANT: When in doubt between conversation and web_search, PREFER web_search.\n" +
    "  It is better to search and provide accurate info than to guess from stale knowledge.\n" +
    "- Default truly ambiguous requests to a single conversation step.\n" +
    "- Steps run in order. Later steps may use results of earlier ones.\n\n" +
    "USER MESSAGE:\n" +
    userMessage +
    "\n\nRETURN JSON (array of steps):\n" +
    '{ "plan": [\n' +
    '  { "step": 1, "tool": "conversation"|"image_generation"|"file_analysis"|"memory_update"|"web_search", "input": "..." }\n' +
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

    const tool =
      typeof item.tool === "string" && VALID_PLAN_TOOLS.has(item.tool)
        ? (item.tool as PlanTool)
        : "conversation";

    const input =
      typeof item.input === "string" && item.input.trim()
        ? item.input.trim()
        : "";

    if (!input) continue;

    steps.push({
      step: steps.length + 1,
      tool,
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
