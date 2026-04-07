// SentIQGPT v2 — Tool Executor
//
// Executes a structured plan produced by the Task Planner.
// Runs each step sequentially, routing to the correct capability:
//
//   conversation     → ChatHandler (Gemini)
//   image_generation → Image Router (FLUX/HF/Pollinations)
//   file_analysis    → ChatHandler + file context
//   memory_update    → MemoryProcessor (force-store)
//   chart_generation → ChartRouter (matplotlib / plotly / chart.js)
//   web_search       → Tavily Search Pipeline (query expansion + LLM synthesis)
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
import { executeTavilySearchPipeline } from "../tools/webSearch/tavilySearchPipeline";
import { processMessageForMemory } from "../ai/MemoryProcessor";
import { DEFAULT_SOLVER_SYSTEM_PROMPT, solveMathDirect } from "../ai/mathVerifier";
import type { BuiltContext } from "../context/contextBuilder";
import type { PlanStep, PlanTool } from "./planner";
import { detectCodeQuery, selectModelForPrompt, isMathQuery } from "./modelRouter";

// ==============================
// Types
// ==============================

export interface StepResult {
  readonly step: number;
  readonly tool: PlanTool;
  /** True when this step was handled by the math pipeline */
  readonly isMathResult?: boolean;
  /** Text output (conversation / file_analysis replies) */
  readonly reply?: string;
  readonly model_used?: string;
  readonly fallback?: boolean;
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
    id?: string;
    type?: string;
    summary?: string;
    importance?: number;
    scope?: "global" | "chat";
    chat_id?: string | null;
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
  "web_search",
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

  // Math path
  // If the query is mathematical, route through the direct MiniMax math solver
  // instead of the standard single-model chat handler.
  if (!detectCodeQuery(input) && isMathQuery(input)) {
    console.log(`[MathPipeline] math query detected — routing to direct minimax solver`);
    const mathResult = await solveMathDirect(augmentedInput, DEFAULT_SOLVER_SYSTEM_PROMPT);
    console.log(
      `[MathPipeline] solved using minimax`,
    );
    return {
      step: 0,
      tool: "conversation",
      isMathResult: true,
      reply: mathResult.answer,
      model_used: mathResult.model_used,
      fallback: mathResult.fallback,
    };
  }

  // ── Standard conversation path ──
  // Pass file context to router for coding PDF detection
  const hasFiles = ctx.fileReferences && ctx.fileReferences.length > 0;
  const fileNames = hasFiles ? ctx.fileReferences.map((f) => f.filename) : undefined;
  const fileContent = hasFiles ? ctx.fileReferences.map((f) => f.extractedText).join("\n") : undefined;
  
  const modelOverride = selectModelForPrompt(input, undefined, {
    hasFile: hasFiles,
    fileNames,
    fileContent,
  });
  
  const result = await handleChat({
    userMessage: augmentedInput,
    recentMessages: ctx.recentMessages,
    memories: ctx.memories,
    fileReferences: ctx.fileReferences,
    conversationSummary: ctx.conversationSummary,
    modelOverride,
    userId: ctx.userId,
  });

  return {
    step: 0,
    tool: "conversation",
    reply: result.reply,
    model_used: result.model_used,
    fallback: result.fallback,
  };
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
  // Pass file context to router for coding PDF detection
  const hasFiles = ctx.fileReferences && ctx.fileReferences.length > 0;
  const fileNames = hasFiles ? ctx.fileReferences.map((f) => f.filename) : undefined;
  const fileContent = hasFiles ? ctx.fileReferences.map((f) => f.extractedText).join("\n") : undefined;
  
  const modelOverride = selectModelForPrompt(input, undefined, {
    hasFile: hasFiles,
    fileNames,
    fileContent,
  });
  
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
    userId: ctx.userId,
  });

  return {
    step: 0,
    tool: "file_analysis",
    reply: result.reply,
    model_used: result.model_used,
    fallback: result.fallback,
  };
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
    userId: ctx.userId,
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

async function execWebSearch(
  input: string,
): Promise<StepResult> {
  console.log(`[WebSearch] executing Tavily pipeline for: "${input.slice(0, 60)}..."`);

  try {
    const result = await executeTavilySearchPipeline({
      query: input,
      maxResults: 8,
      skipLLMSynthesis: false,
    });

    if (!result.success) {
      console.log(`[WebSearch] pipeline failed: ${result.error}`);
      return {
        step: 0,
        tool: "web_search",
        reply: result.error ?? "Web search failed. Please try again.",
        model_used: "tavily",
        fallback: true,
      };
    }

    console.log(`[WebSearch] pipeline success: ${result.results.length} results, ${result.queriesUsed} queries`);

    return {
      step: 0,
      tool: "web_search",
      reply: result.answer,
      model_used: "gemini-fast",
      fallback: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[WebSearch] error: ${message}`);
    return {
      step: 0,
      tool: "web_search",
      reply: "Web search is temporarily unavailable. Please try again later.",
      model_used: "tavily",
      fallback: true,
    };
  }
}

// ==============================
// Parallelization Helpers
// ==============================

/** Tools that can run in parallel (independent, no context dependency) */
const PARALLELIZABLE_TOOLS: ReadonlySet<PlanTool> = new Set([
  "image_generation",
  "chart_generation",
  "memory_update",
  "web_search",
]);

/** Check if a step can run independently (doesn't need prior context) */
function canRunInParallel(tool: PlanTool): boolean {
  return PARALLELIZABLE_TOOLS.has(tool);
}

/** Execute a single step and return the result with proper step number */
async function executeStep(
  planStep: PlanStep,
  ctx: BuiltContext,
  priorContext: string,
): Promise<StepResult> {
  console.log(`[EXECUTOR] running step ${planStep.step} → ${planStep.tool}`);

  if (!VALID_TOOLS.has(planStep.tool)) {
    return {
      step: planStep.step,
      tool: planStep.tool,
      error: `Unknown tool: ${planStep.tool}`,
    };
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
      case "web_search":
        result = await execWebSearch(planStep.input);
        break;
      case "conversation":
      default:
        result = await execConversation(planStep.input, ctx, priorContext);
        break;
    }

    return { ...result, step: planStep.step };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[EXECUTOR] step ${planStep.step} failed: ${message}`);
    return {
      step: planStep.step,
      tool: planStep.tool,
      error: message,
    };
  }
}

/** Build context string from a step result */
function buildContextFromResult(result: StepResult, input: string): string {
  if (result.reply) {
    return result.reply.slice(0, 500);
  }
  if (result.image?.success) {
    return `[Image generated: ${result.image.provider_used ?? "unknown"} — "${input.slice(0, 80)}"]`;
  }
  if (result.chart?.success) {
    return `[Chart generated: ${result.chart.chart_type} (${result.chart.renderer}) — "${input.slice(0, 80)}"]`;
  }
  if (result.memory?.stored) {
    return `[Memory stored: ${result.memory.summary ?? input.slice(0, 80)}]`;
  }
  return "";
}

// ==============================
// Public API
// ==============================

/**
 * Execute an ordered plan, routing each step to its capability module.
 *
 * OPTIMIZATION: Independent steps (image_generation, chart_generation,
 * memory_update, web_search) can run in parallel when they don't depend
 * on prior step outputs. Context-dependent steps (conversation, file_analysis)
 * run sequentially to preserve context threading.
 *
 * Results from prior steps are condensed and forwarded to subsequent
 * steps as context so the LLM can produce coherent multi-step answers.
 */
export async function executePlan(
  steps: readonly PlanStep[],
  ctx: BuiltContext,
): Promise<ExecutionResult> {
  const stepsToExecute = steps.slice(0, MAX_EXEC_STEPS);
  
  // Group steps: parallel-capable vs context-dependent
  // Strategy: Run all parallelizable steps concurrently, then run sequential ones
  const parallelSteps: PlanStep[] = [];
  const sequentialSteps: PlanStep[] = [];

  for (const step of stepsToExecute) {
    if (canRunInParallel(step.tool)) {
      parallelSteps.push(step);
    } else {
      sequentialSteps.push(step);
    }
  }

  const results: StepResult[] = [];
  let priorContext = "";

  // Execute parallel steps concurrently (they don't need prior context)
  if (parallelSteps.length > 0) {
    console.log(`[EXECUTOR] running ${parallelSteps.length} parallel step(s): ${parallelSteps.map(s => s.tool).join(", ")}`);
    const startTime = Date.now();

    const parallelPromises = parallelSteps.map(step => executeStep(step, ctx, ""));
    const parallelResults = await Promise.all(parallelPromises);

    console.log(`[EXECUTOR] parallel execution completed in ${Date.now() - startTime}ms`);

    // Collect results and build context
    for (let i = 0; i < parallelResults.length; i++) {
      const result = parallelResults[i];
      results.push(result);
      const contextPart = buildContextFromResult(result, parallelSteps[i].input);
      if (contextPart) {
        priorContext += (priorContext ? "\n" : "") + contextPart;
      }
    }
  }

  // Execute sequential steps in order (they may need prior context)
  for (const planStep of sequentialSteps) {
    const result = await executeStep(planStep, ctx, priorContext);
    results.push(result);

    const contextPart = buildContextFromResult(result, planStep.input);
    if (contextPart) {
      priorContext += (priorContext ? "\n" : "") + contextPart;
    }
  }

  // Sort results by step number to maintain original order
  results.sort((a, b) => a.step - b.step);

  console.log(`[EXECUTOR] plan complete: ${results.length} steps executed`);
  return { steps: results };
}
