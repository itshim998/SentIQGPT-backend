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
import { routeFileGeneration } from "../tools/fileGeneration/fileGenerator";
import { executeTavilySearchPipeline } from "../tools/webSearch/tavilySearchPipeline";
import { normalizeWebSearchMode } from "../tools/webSearch/webSearchMode";
import { processMessageForMemory } from "../ai/MemoryProcessor";
import { solveMathDirect } from "../ai/mathVerifier";
import type { BuiltContext } from "../context/contextBuilder";
import type { PlanStep, PlanTool } from "./planner";
import { detectCodeQuery, detectImageMathPrompt, selectModelForPrompt, isMathQuery } from "./modelRouter";
import type { SearchResult } from "../tools/webSearch/types";

// ==============================
// Types
// ==============================

export interface StepResult {
  readonly step: number;
  readonly tool: PlanTool;
  /** True when this step was handled by the math pipeline */
  readonly isMathResult?: boolean;
  /** True when the reply must bypass user-facing sanitization */
  readonly sanitize_bypass?: boolean;
  /** Text output (conversation / file_analysis replies) */
  readonly reply?: string;
  /** Optional internal reasoning extracted from think blocks */
  readonly thinking?: string;
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
  /** Generated downloadable file output */
  readonly file?: {
    type?: "file";
    success: boolean;
    format: string;
    file_name: string;
    mime_type: string;
    file_url?: string;
    storage_path?: string;
    storage_bucket?: string;
    file_size_bytes?: number;
    content_sha256?: string;
    version?: number;
    file_id?: string;
    preview?: Record<string, unknown>;
    html?: string;
    text?: string;
    model_used?: string;
    fallback?: boolean;
    fallback_reason?: string | null;
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
    persisted?: boolean;
    source_conversation_id?: string | null;
  };
  /** Web search payload (web_search) */
  readonly web_search?: {
    query: string;
    answer?: string;
    images?: string[];
    results: SearchResult[];
    sources: Array<{ title: string; url: string }>;
    queriesUsed: number;
    provider?: string;
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
  "file_generation",
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
  // If the query is mathematical, route through the direct openai-large math solver
  // instead of the standard single-model chat handler.
  const hasImageMathPrompt =
    (ctx.imageAttachments?.length ?? 0) > 0 &&
    detectImageMathPrompt(input);
  if (!detectCodeQuery(input) && (isMathQuery(input) || hasImageMathPrompt)) {
    console.log(`[MathPipeline] math query detected — routing to direct openai-large solver`);
    const mathResult = await solveMathDirect(augmentedInput, ctx.userId, ctx.imageAttachments);
    console.log(
      `[MathPipeline] solved using openai-large`,
    );
    return {
      step: 0,
      tool: "conversation",
      isMathResult: true,
      sanitize_bypass: true,
      reply: mathResult.answer,
      thinking: mathResult.thinking,
      model_used: mathResult.model_used,
      fallback: mathResult.fallback,
    };
  }

  // ── Standard conversation path ──
  // Pass file context to router for coding PDF detection
  const hasFiles = ctx.fileReferences && ctx.fileReferences.length > 0;
  const hasImages = ctx.imageAttachments && ctx.imageAttachments.length > 0;
  const fileNames = hasFiles ? ctx.fileReferences.map((f) => f.filename) : undefined;
  const fileContent = hasFiles ? ctx.fileReferences.map((f) => f.extractedText).join("\n") : undefined;
  
  const modelOverride = selectModelForPrompt(input, undefined, {
    hasImage: hasImages,
    hasFile: hasFiles,
    fileNames,
    fileContent,
  });
  
  const result = await handleChat({
    userMessage: augmentedInput,
    recentMessages: ctx.recentMessages,
    memories: ctx.memories,
    fileReferences: ctx.fileReferences,
    imageAttachments: ctx.imageAttachments,
    conversationSummary: ctx.conversationSummary,
    priorConversationEvidence: ctx.priorConversationEvidence,
    isExplicitRecallQuery: ctx.isExplicitRecallQuery,
    trustedProfile: ctx.trustedProfile,
    modelOverride,
    userId: ctx.userId,
  });

  return {
    step: 0,
    tool: "conversation",
    reply: result.reply,
    thinking: result.thinking,
    model_used: result.model_used,
    fallback: result.fallback,
    sanitize_bypass: result.sanitize_bypass,
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
  const hasImages = ctx.imageAttachments && ctx.imageAttachments.length > 0;
  const fileNames = hasFiles ? ctx.fileReferences.map((f) => f.filename) : undefined;
  const fileContent = hasFiles ? ctx.fileReferences.map((f) => f.extractedText).join("\n") : undefined;
  
  const modelOverride = selectModelForPrompt(input, undefined, {
    hasImage: hasImages,
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
    imageAttachments: ctx.imageAttachments,
    conversationSummary: ctx.conversationSummary,
    priorConversationEvidence: ctx.priorConversationEvidence,
    isExplicitRecallQuery: ctx.isExplicitRecallQuery,
    trustedProfile: ctx.trustedProfile,
    modelOverride,
    userId: ctx.userId,
  });

  return {
    step: 0,
    tool: "file_analysis",
    reply: result.reply,
    thinking: result.thinking,
    model_used: result.model_used,
    fallback: result.fallback,
    sanitize_bypass: result.sanitize_bypass,
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

async function execFileGeneration(
  input: string,
  ctx: BuiltContext,
): Promise<StepResult> {
  const result = await routeFileGeneration({
    userMessage: input,
    userId: ctx.userId || "",
    conversationId: ctx.conversationId || "",
    userDb: ctx.userDb,
  });

  return {
    step: 0,
    tool: "file_generation",
    reply: result.success
      ? `Generated ${result.file_name}.`
      : (result.error || "Sorry, I couldn't generate that file. Please try again."),
    model_used: result.model_used,
    fallback: result.fallback,
    file: {
      type: result.type,
      success: result.success,
      format: result.format,
      file_name: result.file_name,
      mime_type: result.mime_type,
      file_url: result.file_url,
      storage_path: result.storage_path,
      storage_bucket: result.storage_bucket,
      file_size_bytes: result.file_size_bytes,
      content_sha256: result.content_sha256,
      version: result.version,
      file_id: result.file_id,
      preview: result.preview as Record<string, unknown> | undefined,
      html: result.html,
      text: result.text,
      model_used: result.model_used,
      fallback: result.fallback,
      fallback_reason: result.fallback_reason,
      error: result.error,
    },
  };
}

async function execWebSearch(
  input: string,
  ctx: BuiltContext,
): Promise<StepResult> {
  console.log(`[WebSearch] executing Tavily pipeline for: "${input.slice(0, 60)}..."`);
  const webSearchMode = normalizeWebSearchMode(ctx.webSearchMode);

  try {
    const result = await executeTavilySearchPipeline({
      query: input,
      maxResults: 8,
      skipLLMSynthesis: true,
      webSearchMode,
    });

    if (!result.success) {
      console.log(`[WebSearch] pipeline failed: ${result.error}`);
      return {
        step: 0,
        tool: "web_search",
        reply: result.error ?? "Web search failed. Please try again.",
        fallback: true,
      };
    }

    console.log(`[WebSearch] pipeline success: ${result.results.length} results, ${result.queriesUsed} queries`);

    return {
      step: 0,
      tool: "web_search",
      reply: result.answer,
      fallback: !result.answer,
      web_search: {
        query: result.query,
        answer: result.answer,
        images: result.images ?? [],
        results: result.results,
        sources: result.sources,
        queriesUsed: result.queriesUsed,
        provider: result.provider,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[WebSearch] error: ${message}`);
    return {
      step: 0,
      tool: "web_search",
      reply: "Web search is temporarily unavailable. Please try again later.",
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
  "file_generation",
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
      case "file_generation":
        result = await execFileGeneration(planStep.input, ctx);
        break;
      case "web_search":
        result = await execWebSearch(planStep.input, ctx);
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
  if (result.file?.success) {
    return `[File generated: ${result.file.file_name} (${result.file.format}) - "${input.slice(0, 80)}"]`;
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

  const results: StepResult[] = [];
  let priorContext = "";

  for (let index = 0; index < stepsToExecute.length;) {
    const planStep = stepsToExecute[index];

    if (canRunInParallel(planStep.tool)) {
      const group: PlanStep[] = [];
      while (
        index < stepsToExecute.length &&
        canRunInParallel(stepsToExecute[index].tool)
      ) {
        group.push(stepsToExecute[index]);
        index += 1;
      }

      console.log(`[EXECUTOR] running ${group.length} ordered parallel step(s): ${group.map(s => s.tool).join(", ")}`);
      const startTime = Date.now();
      const groupResults = await Promise.all(group.map(step => executeStep(step, ctx, "")));
      console.log(`[EXECUTOR] ordered parallel group completed in ${Date.now() - startTime}ms`);

      for (let i = 0; i < groupResults.length; i++) {
        const result = groupResults[i];
        results.push(result);
        const contextPart = buildContextFromResult(result, group[i].input);
        if (contextPart) {
          priorContext += (priorContext ? "\n" : "") + contextPart;
        }
      }
      continue;
    }

    const result = await executeStep(planStep, ctx, priorContext);
    results.push(result);
    const contextPart = buildContextFromResult(result, planStep.input);
    if (contextPart) {
      priorContext += (priorContext ? "\n" : "") + contextPart;
    }
    index += 1;
  }

  // Sort results by step number to maintain original order
  results.sort((a, b) => a.step - b.step);

  console.log(`[EXECUTOR] plan complete: ${results.length} steps executed`);
  return { steps: results };
}
