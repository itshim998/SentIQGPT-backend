// SentIQGPT v2 — Tool Executor
//
// Executes a structured plan produced by the Task Planner.
// Runs each step sequentially, routing to the correct capability:
//
//   conversation    → ChatHandler (Gemini)
//   image_generation → Image Router (FLUX/HF/Pollinations)
//   file_analysis    → ChatHandler + file context
//   memory_update    → MemoryProcessor (force-store)
//   chart_generation → ChartRouter (matplotlib / plotly / chart.js)
//
// Results from earlier steps are threaded into later steps as
// additional context so the LLM can build on prior outputs.
//
// Safety:
//   • Validates that each tool exists before executing
//   • Max 3 steps enforced by the planner (executor also guards)
//   • Each step has an independent timeout (inherits from LLM call)

import { handleChat } from "../ai/ChatHandler";
import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";
import { routeChartGeneration } from "../tools/chartGeneration/chartRouter";
import { processMessageForMemory } from "../ai/MemoryProcessor";
import { verifyMathAnswer } from "../ai/mathVerifier";
import type { BuiltContext } from "../context/contextBuilder";
import type { PlanStep, PlanTool } from "./planner";
import { detectCodeQuery, selectModelForPrompt, isMathQuery } from "./modelRouter";

// ==============================
// Types
// ==============================

export interface StepResult {
  readonly step: number;
  readonly tool: PlanTool;
  /** True when this step was handled by the math verification pipeline */
  readonly isMathResult?: boolean;
  /** Text output (conversation / file_analysis replies) */
  readonly reply?: string;
  /** Image output (image_generation) */
  readonly image?: {
    success: boolean;
    image_url?: string;
    image_base64?: string;
    provider_used?: string;
    prompt: string;
    error?: string;
  };
  /** Chart output (chart_generation) */
  readonly chart?: {
    type?: "chart";
    success: boolean;
    chart_type: string;
    renderer: string;
    code: string;
    preview?: string;
    image_base64?: string;
    image_url?: string;
    plotly_json?: Record<string, unknown>;
    chartjs_config?: Record<string, unknown>;
    error?: string;
  };
  /** Memory output (memory_update) */
  readonly memory?: {
    stored: boolean;
    type?: string;
    summary?: string;
    importance?: number;
  };
  readonly error?: string;
}

export interface ExecutionResult {
  readonly steps: readonly StepResult[];
}

const VALID_TOOLS: ReadonlySet<string> = new Set<PlanTool>([
  "conversation",
  "image_generation",
  "file_analysis",
  "memory_update",
  "chart_generation",
]);

const MAX_EXEC_STEPS = 3;

// ==============================
// Per-tool executors
// ==============================

async function execConversation(
  input: string,
  ctx: BuiltContext,
  priorContext: string,
): Promise<StepResult> {
  const augmentedInput = priorContext
    ? `${input}\n\n[Previous step context]: ${priorContext}`
    : input;

  // ── Math verification path ──
  // If the query is mathematical, route through the two-model verification system
  // instead of the standard single-model chat handler.
  if (!detectCodeQuery(input) && isMathQuery(input)) {
    console.log(`[MathPipeline] math query detected — routing to deepseek verification pipeline`);
    const systemPrompt =
      "SYSTEM: You are SentIQGPT, a knowledgeable and helpful AI assistant.\n" +
      "Provide clear, step-by-step mathematical reasoning.\n" +
      "Show your work and verify your calculations.";

    const mathResult = await verifyMathAnswer(augmentedInput, systemPrompt);
    console.log(
      `[MathPipeline] solving with deepseek — verified=${mathResult.verified} agreed=${mathResult.agreed} reconciled=${mathResult.reconciled}`,
    );
    return { step: 0, tool: "conversation", isMathResult: true, reply: mathResult.answer };
  }

  // ── Standard conversation path ──
  const modelOverride = selectModelForPrompt(input);
  const result = await handleChat({
    userMessage: augmentedInput,
    recentMessages: ctx.recentMessages,
    memories: ctx.memories,
    fileReferences: ctx.fileReferences,
    conversationSummary: ctx.conversationSummary,
    modelOverride,
  });

  return { step: 0, tool: "conversation", reply: result.reply };
}

async function execImageGeneration(
  input: string,
): Promise<StepResult> {
  const result = await routeImageGeneration({ prompt: input });

  return {
    step: 0,
    tool: "image_generation",
    image: {
      success: result.success,
      image_url: result.image_url,
      image_base64: result.image_base64,
      provider_used: result.provider_used,
      prompt: result.prompt,
      error: result.error,
    },
  };
}

async function execFileAnalysis(
  input: string,
  ctx: BuiltContext,
  priorContext: string,
): Promise<StepResult> {
  const modelOverride = selectModelForPrompt(input);
  const augmentedInput = priorContext
    ? `${input}\n\n[Previous step context]: ${priorContext}`
    : input;

  const result = await handleChat({
    userMessage: augmentedInput,
    recentMessages: ctx.recentMessages,
    memories: ctx.memories,
    fileReferences: ctx.fileReferences,
    conversationSummary: ctx.conversationSummary,
    modelOverride,
  });

  return { step: 0, tool: "file_analysis", reply: result.reply };
}

async function execMemoryUpdate(
  input: string,
  ctx: BuiltContext,
): Promise<StepResult> {
  const memResult = await processMessageForMemory({
    message: input,
    recentMessages: ctx.recentMessages,
    existingMemories: ctx.memories,
    forceStore: true,
  }).catch(() => ({ stored: false as const }));

  const memory = memResult.stored
    ? {
        stored: true,
        type: memResult.memory?.type,
        summary: memResult.memory?.summary,
        importance: memResult.memory?.importance,
      }
    : { stored: false };

  return { step: 0, tool: "memory_update", memory };
}

async function execChartGeneration(
  input: string,
): Promise<StepResult> {
  const result = await routeChartGeneration({
    userMessage: input,
    fetchPreview: true,
  });

  return {
    step: 0,
    tool: "chart_generation",
    chart: {
      type: result.type,
      success: result.success,
      chart_type: result.chart_type,
      renderer: result.renderer,
      code: result.code,
      preview: result.preview,
      image_base64: result.image_base64,
      image_url: result.image_url,
      plotly_json: result.plotly_json as Record<string, unknown> | undefined,
      chartjs_config: result.chartjs_config as Record<string, unknown> | undefined,
      error: result.error,
    },
  };
}

// ==============================
// Public API
// ==============================

/**
 * Execute an ordered plan, routing each step to its capability module.
 *
 * Results from prior steps are condensed and forwarded to subsequent
 * steps as context so the LLM can produce coherent multi-step answers.
 */
export async function executePlan(
  steps: readonly PlanStep[],
  ctx: BuiltContext,
): Promise<ExecutionResult> {
  const results: StepResult[] = [];
  let priorContext = "";

  for (const planStep of steps.slice(0, MAX_EXEC_STEPS)) {
    console.log(`[EXECUTOR] running step ${planStep.step} → ${planStep.tool}`);

    // Guard: reject unknown tools
    if (!VALID_TOOLS.has(planStep.tool)) {
      results.push({
        step: planStep.step,
        tool: planStep.tool,
        error: `Unknown tool: ${planStep.tool}`,
      });
      continue;
    }

    try {
      let result: StepResult;

      switch (planStep.tool) {
        case "image_generation":
          result = await execImageGeneration(planStep.input);
          break;
        case "file_analysis":
          result = await execFileAnalysis(planStep.input, ctx, priorContext);
          break;
        case "memory_update":
          result = await execMemoryUpdate(planStep.input, ctx);
          break;
        case "chart_generation":
          result = await execChartGeneration(planStep.input);
          break;
        case "conversation":
        default:
          result = await execConversation(planStep.input, ctx, priorContext);
          break;
      }

      // Stamp the correct step number
      result = { ...result, step: planStep.step };
      results.push(result);

      // Build running context for subsequent steps
      if (result.reply) {
        priorContext += (priorContext ? "\n" : "") + result.reply.slice(0, 500);
      } else if (result.image?.success) {
        priorContext += (priorContext ? "\n" : "") +
          `[Image generated: ${result.image.provider_used ?? "unknown"} — "${planStep.input.slice(0, 80)}"]`;
      } else if (result.chart?.success) {
        priorContext += (priorContext ? "\n" : "") +
          `[Chart generated: ${result.chart.chart_type} (${result.chart.renderer}) — "${planStep.input.slice(0, 80)}"]`;
      } else if (result.memory?.stored) {
        priorContext += (priorContext ? "\n" : "") +
          `[Memory stored: ${result.memory.summary ?? planStep.input.slice(0, 80)}]`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[EXECUTOR] step ${planStep.step} failed: ${message}`);
      results.push({
        step: planStep.step,
        tool: planStep.tool,
        error: message,
      });
    }
  }

  console.log(`[EXECUTOR] plan complete: ${results.length} steps executed`);
  return { steps: results };
}
