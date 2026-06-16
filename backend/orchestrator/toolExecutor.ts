// SentIQ Chat v2 — Tool Executor
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
import { createHash, randomUUID } from "crypto";
import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";
import { routeChartGeneration } from "../tools/chartGeneration/chartRouter";
import { routeFileGeneration } from "../tools/fileGeneration/fileGenerator";
import { executeTavilySearchPipeline } from "../tools/webSearch/tavilySearchPipeline";
import { normalizeWebSearchMode } from "../tools/webSearch/webSearchMode";
import { processMessageForMemory } from "../ai/MemoryProcessor";
import { resolveContextReferences } from "../context/referenceResolver";
import type { BuiltContext } from "../context/contextBuilder";
import type { PlanStep, PlanTool } from "./planner";
import { selectImageModelPreferenceWithMaster, selectModelForPromptWithMaster } from "./masterRouter";
import type { SearchResult } from "../tools/webSearch/types";
import { INTUITIVE_PROFILE, type ExecutionProfile } from "./executionProfile";
import { BillingQuotaError, BillingQuotaService } from "../billing/quotaService";
import { getImageModelForPlan } from "../billing/modelEntitlementRouter";
import type { UsageReservation } from "../billing/entitlementTypes";

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
    embedding?: readonly number[];
    scope?: "global" | "chat";
    chat_id?: string | null;
    persisted?: boolean;
    source_conversation_id?: string | null;
    failure_reason?: string;
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

export interface ExecutePlanOptions {
  readonly profile?: ExecutionProfile;
  readonly signal?: AbortSignal;
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
const billingQuotaService = new BillingQuotaService();

function createBillingStepRequestId(ctx: BuiltContext, tool: PlanTool, input: string): string {
  const base = ctx.billingRequestId || `orchestrator:${ctx.userId || "guest"}:${randomUUID()}`;
  const inputHash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `${base}:${tool}:${inputHash}`;
}

async function releaseBillingReservation(reservation: UsageReservation | null | undefined): Promise<void> {
  if (!reservation) return;
  await billingQuotaService.release(reservation).catch((error) => {
    console.warn(`[Billing] failed to release reservation ${reservation.requestId}: ${error instanceof Error ? error.message : error}`);
  });
}

function safeImageGenerationFailureMessage(): string {
  return "Image generation could not finish. Please try again.";
}

function safeChartGenerationFailureMessage(): string {
  return "Chart generation could not finish. Please try again.";
}

function safeFileGenerationFailureMessage(): string {
  return "Sorry, I couldn't generate that file. Please try again.";
}

function safeWebSearchFailureMessage(error?: string): string {
  if (error && /no results found/i.test(error)) {
    return "I couldn't find current web results for that. Please try again with a more specific query.";
  }
  return "Web search is temporarily unavailable. Please try again later.";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Execution aborted");
}

// ==============================
// Per-tool executors
// ==============================

async function execConversation(
  input: string,
  ctx: BuiltContext,
  priorContext: string,
  profile: ExecutionProfile,
  signal?: AbortSignal,
): Promise<StepResult> {
  const augmentedInput = priorContext
    ? `${input}\n\n[Previous step context]: ${priorContext}`
    : input;

  // ── Standard conversation path ──
  // Pass file context to router for coding PDF detection
  const hasFiles = ctx.fileReferences && ctx.fileReferences.length > 0;
  const hasImages = ctx.imageAttachments && ctx.imageAttachments.length > 0;
  const fileNames = hasFiles ? ctx.fileReferences.map((f) => f.filename) : undefined;
  const fileContent = hasFiles ? ctx.fileReferences.map((f) => f.extractedText).join("\n") : undefined;
  
  const routedModel = await selectModelForPromptWithMaster({
    query: input,
    options: {
      hasImage: hasImages,
      hasFile: hasFiles,
      fileNames,
      fileContent,
    },
    executionMode: profile.mode,
    userId: ctx.userId,
    isGuest: ctx.userId === "guest",
    signal,
  });
  const reservation = ctx.billingIdentity
    ? await billingQuotaService.reserveTextRoute({
        identity: ctx.billingIdentity,
        requestId: createBillingStepRequestId(ctx, "conversation", augmentedInput),
        conversationId: ctx.conversationId,
        clientRequestId: ctx.billingRequestId,
        metadata: { endpoint: "orchestrator", tool: "conversation", routed_model: routedModel.model },
      })
    : null;
  const modelOverride = reservation?.adapterModelOverride ?? routedModel.model;

  if (routedModel.source === "deterministic" && routedModel.fallback_reason) {
    console.log(`[MasterRouter] conversation deterministic fallback=${routedModel.fallback_reason}`);
  }
  
  let result: Awaited<ReturnType<typeof handleChat>>;
  try {
    result = await handleChat({
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
      reasoningEffort: profile.model.reasoningEffort,
      signal,
    });
    if (reservation) {
      await billingQuotaService.commit(reservation, { endpoint: "orchestrator", tool: "conversation" });
    }
  } catch (error) {
    await releaseBillingReservation(reservation);
    throw error;
  }

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
  ctx: BuiltContext,
  profile: ExecutionProfile,
  signal?: AbortSignal,
): Promise<StepResult> {
  let reservation: UsageReservation | null = null;
  let committedReservation: UsageReservation | null = null;
  let preferredModel: string | undefined;

  if (ctx.billingIdentity) {
    const initialRoute = getImageModelForPlan("free", input);
    reservation = await billingQuotaService.reserveFeature({
      identity: ctx.billingIdentity,
      feature: "image_generation",
      requestId: createBillingStepRequestId(ctx, "image_generation", input),
      route: initialRoute,
      conversationId: ctx.conversationId,
      clientRequestId: ctx.billingRequestId,
      metadata: { endpoint: "orchestrator", tool: "image_generation" },
    });
    const entitledRoute = getImageModelForPlan(reservation.planCode, input);
    preferredModel = entitledRoute.adapterModelOverride;
    committedReservation = {
      ...reservation,
      provider: entitledRoute.provider,
      model: entitledRoute.model,
      adapterModelOverride: entitledRoute.adapterModelOverride,
      safeModelLabel: entitledRoute.safeModelLabel,
      route: entitledRoute.route,
    };
  } else {
    preferredModel = await selectImageModelPreferenceWithMaster({
      prompt: input,
      executionMode: profile.mode,
      userId: ctx.userId,
      isGuest: ctx.userId === "guest",
      signal,
    });
  }

  let result: Awaited<ReturnType<typeof routeImageGeneration>>;
  try {
    result = await routeImageGeneration({ prompt: input, userId: ctx.userId, signal, preferredModel: preferredModel as any });
    if (result.success && committedReservation) {
      await billingQuotaService.commit(committedReservation, { endpoint: "orchestrator", tool: "image_generation" });
    } else if (!result.success) {
      await releaseBillingReservation(committedReservation ?? reservation);
    }
  } catch (error) {
    await releaseBillingReservation(committedReservation ?? reservation);
    throw error;
  }

  return {
    step: 0,
    tool: "image_generation",
    reply: result.success
      ? "Generated image."
      : safeImageGenerationFailureMessage(),
    image: {
      success: result.success,
      image_url: result.image_url,
      image_base64: result.image_base64,
      provider_used: result.provider_used,
      prompt: result.prompt,
      error: result.success ? undefined : safeImageGenerationFailureMessage(),
    },
  };
}

async function execFileAnalysis(
  input: string,
  ctx: BuiltContext,
  priorContext: string,
  profile: ExecutionProfile,
  signal?: AbortSignal,
): Promise<StepResult> {
  const augmentedInput = priorContext
    ? `${input}\n\n[Previous step context]: ${priorContext}`
    : input;

  // Pass file context to router for coding PDF detection
  const hasFiles = ctx.fileReferences && ctx.fileReferences.length > 0;
  const hasImages = ctx.imageAttachments && ctx.imageAttachments.length > 0;
  const fileNames = hasFiles ? ctx.fileReferences.map((f) => f.filename) : undefined;
  const fileContent = hasFiles ? ctx.fileReferences.map((f) => f.extractedText).join("\n") : undefined;
  
  const routedModel = await selectModelForPromptWithMaster({
    query: input,
    options: {
      hasImage: hasImages,
      hasFile: hasFiles,
      fileNames,
      fileContent,
    },
    executionMode: profile.mode,
    userId: ctx.userId,
    isGuest: ctx.userId === "guest",
    signal,
  });
  const reservation = ctx.billingIdentity
    ? await billingQuotaService.reserveTextRoute({
        identity: ctx.billingIdentity,
        requestId: createBillingStepRequestId(ctx, "file_analysis", augmentedInput),
        conversationId: ctx.conversationId,
        clientRequestId: ctx.billingRequestId,
        metadata: { endpoint: "orchestrator", tool: "file_analysis", routed_model: routedModel.model },
      })
    : null;
  const modelOverride = reservation?.adapterModelOverride ?? routedModel.model;

  if (routedModel.source === "deterministic" && routedModel.fallback_reason) {
    console.log(`[MasterRouter] file_analysis deterministic fallback=${routedModel.fallback_reason}`);
  }
  
  let result: Awaited<ReturnType<typeof handleChat>>;
  try {
    result = await handleChat({
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
      reasoningEffort: profile.model.reasoningEffort,
      signal,
    });
    if (reservation) {
      await billingQuotaService.commit(reservation, { endpoint: "orchestrator", tool: "file_analysis" });
    }
  } catch (error) {
    await releaseBillingReservation(reservation);
    throw error;
  }

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
  profile: ExecutionProfile,
  signal?: AbortSignal,
): Promise<StepResult> {
  throwIfAborted(signal);
  const memResult = await processMessageForMemory({
    message: input,
    recentMessages: ctx.recentMessages,
    existingMemories: ctx.memories,
    forceStore: true,
    userId: ctx.userId,
    generateEmbedding: profile.persistence.blockOnMemoryEmbedding,
  }).catch((error) => ({
    stored: false as const,
    failure_reason: error instanceof Error ? error.message : String(error),
  }));

  const memory = memResult.stored
    ? {
        stored: true,
        ...memResult.memory,
      }
    : { stored: false, failure_reason: memResult.failure_reason };

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
    reply: result.success
      ? "Generated chart."
      : safeChartGenerationFailureMessage(),
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
      error: result.success ? undefined : safeChartGenerationFailureMessage(),
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
      : safeFileGenerationFailureMessage(),
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
      error: result.success ? undefined : safeFileGenerationFailureMessage(),
    },
  };
}

async function execWebSearch(
  input: string,
  ctx: BuiltContext,
  signal?: AbortSignal,
): Promise<StepResult> {
  console.log(`[WebSearch] executing Tavily pipeline for: "${input.slice(0, 60)}..."`);
  const webSearchMode = normalizeWebSearchMode(ctx.webSearchMode);

  try {
    const result = await executeTavilySearchPipeline({
      query: input,
      maxResults: 8,
      skipLLMSynthesis: true,
      webSearchMode,
      signal,
    });

    if (!result.success) {
      console.log(`[WebSearch] pipeline failed: ${result.error}`);
      return {
        step: 0,
        tool: "web_search",
        reply: safeWebSearchFailureMessage(result.error),
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
    if (signal?.aborted) {
      throwIfAborted(signal);
    }
    if (err instanceof BillingQuotaError) {
      throw err;
    }
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

/** Execute a single step and return the result with proper step number */
async function executeStep(
  planStep: PlanStep,
  ctx: BuiltContext,
  priorContext: string,
  profile: ExecutionProfile,
  signal?: AbortSignal,
): Promise<StepResult> {
  throwIfAborted(signal);
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
    const resolved = planStep.tool === "memory_update"
      ? {
          resolved: planStep.input,
          changed: false,
          needsClarification: false,
          confidence: 1,
          candidates: [] as readonly string[],
          subject: undefined as string | undefined,
          source: undefined as "conversation" | "summary" | "chat_memory" | undefined,
        }
      : resolveContextReferences({
          input: planStep.input,
          tool: planStep.tool,
          recentMessages: ctx.recentMessages,
          conversationSummary: ctx.conversationSummary,
          memories: ctx.memories,
        });
    const stepInput = resolved.resolved;
    if (resolved.changed) {
      console.log(
        `[CONTEXT AWARENESS] ${planStep.tool} resolved "${planStep.input.slice(0, 80)}" -> "${stepInput.slice(0, 120)}" ` +
        `subject="${resolved.subject ?? ""}" source=${resolved.source ?? "none"} confidence=${resolved.confidence.toFixed(2)}`,
      );
    } else if (resolved.needsClarification) {
      console.log(
        `[CONTEXT AWARENESS] ${planStep.tool} reference unresolved input="${planStep.input.slice(0, 80)}" ` +
        `candidates=${resolved.candidates.join(" | ")}`,
      );
    }

    switch (planStep.tool) {
      case "image_generation":
        result = await execImageGeneration(stepInput, ctx, profile, signal);
        break;
      case "file_analysis":
        result = await execFileAnalysis(stepInput, ctx, priorContext, profile, signal);
        break;
      case "memory_update":
        result = await execMemoryUpdate(stepInput, ctx, profile, signal);
        break;
      case "chart_generation":
        result = await execChartGeneration(stepInput);
        break;
      case "file_generation":
        result = await execFileGeneration(stepInput, ctx);
        break;
      case "web_search":
        result = await execWebSearch(stepInput, ctx, signal);
        break;
      case "conversation":
      default:
        result = await execConversation(stepInput, ctx, priorContext, profile, signal);
        break;
    }

    throwIfAborted(signal);
    return { ...result, step: planStep.step };
  } catch (err) {
    if (signal?.aborted) {
      throwIfAborted(signal);
    }
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
 * Side-effectful and quota-consuming tools run sequentially to preserve
 * ordering and avoid partial parallel commits.
 *
 * Results from prior steps are condensed and forwarded to subsequent
 * steps as context so the LLM can produce coherent multi-step answers.
 */
export async function executePlan(
  steps: readonly PlanStep[],
  ctx: BuiltContext,
  options: ExecutePlanOptions = {},
): Promise<ExecutionResult> {
  const profile = options.profile ?? INTUITIVE_PROFILE;
  const signal = options.signal;
  const stepsToExecute = steps.slice(0, MAX_EXEC_STEPS);

  const results: StepResult[] = [];
  let priorContext = "";

  for (let index = 0; index < stepsToExecute.length; index += 1) {
    throwIfAborted(signal);
    const planStep = stepsToExecute[index];

    const result = await executeStep(planStep, ctx, priorContext, profile, signal);
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
