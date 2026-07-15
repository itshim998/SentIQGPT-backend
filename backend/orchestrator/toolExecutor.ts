// Executes one ordinary model turn or an explicit manual WebSurf request.
// Validated provider-neutral model tool calls enter terminal tool executors
// directly and cannot be produced by this local plan boundary.

import { handleChat } from "../ai/ChatHandler";
import { createHash, randomUUID } from "crypto";
import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";
import { routeChartGeneration } from "../tools/chartGeneration/chartRouter";
import { routeFileGeneration } from "../tools/fileGeneration/fileGenerator";
import { executeTavilySearchPipeline } from "../tools/webSearch/tavilySearchPipeline";
import { normalizeWebSearchMode } from "../tools/webSearch/webSearchMode";
import { isWebSurfV2Enabled, prepareWebSurfV2, type WebSurfV2Evidence, type WebSurfV2Payload } from "../tools/webSearch/webSurfV2";
import { prepareModelSelectedMemory } from "../ai/MemoryProcessor";
import type { BuiltContext } from "../context/contextBuilder";
import type { PlanStep, PlanTool } from "./planner";
import { selectImageModelForCapabilities, selectModelForCapabilities } from "./capabilityModelSelector";
import type { SearchResult } from "../tools/webSearch/types";
import { INTUITIVE_PROFILE, type ExecutionProfile } from "./executionProfile";
import { BillingQuotaError, BillingQuotaService } from "../billing/quotaService";
import { getGeminiStandardCapabilityRoute, getImageModelForPlan } from "../billing/modelEntitlementRouter";
import type { UsageReservation } from "../billing/entitlementTypes";
import {
  findExistingAssistantImageMessage,
  persistGeneratedImageResult,
} from "../services/generatedImagePersistenceService";
import { getImageStorageDatabase } from "../dbRouter";
import { commitImageQuotaSuccess, getQuotaInfo } from "../middleware/imageQuota";
import {
  deriveRequiredModelCapabilities,
  getAutomaticSentIQToolsForRoute,
  getEnabledAutomaticSentIQTools,
  routeSupportsCapabilities,
} from "../ai/modelToolCapability";
import type { ToolLifecycleEvent, ValidatedToolCall } from "./toolContract";
import { AutomaticToolDispatchError, dispatchAutomaticModelToolCall } from "../ai/modelToolExecution";
import type { GeneratedFileFormat } from "../tools/fileGeneration/types";
import { getConversationMessageByClientRequestId } from "../services/conversationService";
import { authorizeAutomaticMemoryUpdate, enforceAutomaticMemoryScope } from "../ai/modelToolMemorySafety";

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
    persisted?: boolean;
    deduplicated?: boolean;
    storage_path?: string;
    file_size_bytes?: number;
    warning?: string;
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
    deduplicated?: boolean;
    /** Server-only and non-enumerable; never serialize into public responses or logs. */
    automatic_idempotency_key?: string;
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
    v2?: WebSurfV2Payload;
  };
  readonly error?: string;
  readonly tool_events?: readonly ToolLifecycleEvent[];
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
  "web_search",
]);

const MAX_EXEC_STEPS = 1;
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

function safeAutomaticToolFailure(call: ValidatedToolCall): Pick<StepResult, "tool" | "reply"> {
  switch (call.name) {
    case "web_surf": return { tool: "web_search", reply: safeWebSearchFailureMessage() };
    case "image_gen": return { tool: "image_generation", reply: safeImageGenerationFailureMessage() };
    case "chart_gen": return { tool: "chart_generation", reply: safeChartGenerationFailureMessage() };
    case "file_gen": return { tool: "file_generation", reply: safeFileGenerationFailureMessage() };
    case "memory_update": return {
      tool: "memory_update",
      reply: "I couldn't store that memory. Please phrase it as something to remember about your identity, preferences, or project.",
    };
  }
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
  webSurfEvidence?: WebSurfV2Evidence,
): Promise<StepResult> {
  const augmentedInput = priorContext
    ? `${input}\n\n[Previous step context]: ${priorContext}`
    : input;

  // Provider choice is based only on required input capabilities.
  const hasFiles = ctx.fileReferences && ctx.fileReferences.length > 0;
  const hasImages = ctx.imageAttachments && ctx.imageAttachments.length > 0;
  const fileNames = hasFiles ? ctx.fileReferences.map((f) => f.filename) : undefined;
  const fileContent = hasFiles ? ctx.fileReferences.map((f) => f.extractedText).join("\n") : undefined;
  
  const routedModel = await selectModelForCapabilities({
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
  const requestedAutomaticTools = !priorContext && !webSurfEvidence && !ctx.webSearchMode
    ? getEnabledAutomaticSentIQTools()
    : [];
  const requiredCapabilities = deriveRequiredModelCapabilities({
    hasImageInput: hasImages,
    automaticToolsRequested: requestedAutomaticTools.length > 0,
    streaming: false,
  });
  const reservation = ctx.billingIdentity
    ? await billingQuotaService.reserveTextRoute({
        identity: ctx.billingIdentity,
        requestId: createBillingStepRequestId(ctx, "conversation", augmentedInput),
        conversationId: ctx.conversationId,
        clientRequestId: ctx.billingRequestId,
        metadata: { endpoint: "orchestrator", tool: "conversation", routed_model: routedModel.model },
        requiredCapabilities,
      })
    : null;
  const unreservedRoute = routeSupportsCapabilities(
    { provider: routedModel.provider, model: routedModel.model },
    requiredCapabilities,
  )
    ? { provider: routedModel.provider, model: routedModel.model, adapterModelOverride: routedModel.model }
    : getGeminiStandardCapabilityRoute();
  const finalRoute = reservation ?? unreservedRoute;
  const modelOverride = finalRoute.adapterModelOverride;

  if (routedModel.fallback_reason) {
    console.log(`[ModelSelector] conversation capability=${routedModel.fallback_reason}`);
  }
  
  const automaticTools = requestedAutomaticTools.length > 0
    ? getAutomaticSentIQToolsForRoute(finalRoute, false)
    : [];
  let result: Awaited<ReturnType<typeof handleChat>>;
  try {
    result = await handleChat({
      userMessage: input,
      recentMessages: ctx.recentMessages,
      memories: ctx.memories,
      fileReferences: ctx.fileReferences,
      imageAttachments: ctx.imageAttachments,
      conversationSummary: ctx.conversationSummary,
      conversationCapsule: ctx.conversationCapsule,
      workspaceCapsule: ctx.workspaceCapsule,
      priorConversationEvidence: ctx.priorConversationEvidence,
      routeEvidence: webSurfEvidence?.routeEvidence ?? (priorContext
        ? [{ content: priorContext, label: "previous step", required: true, relevance: 1 }]
        : undefined),
      isExplicitRecallQuery: ctx.isExplicitRecallQuery,
      trustedProfile: ctx.trustedProfile,
      modelOverride,
      userId: ctx.userId,
      reasoningEffort: profile.model.reasoningEffort,
      signal,
      webSurfSourceIds: webSurfEvidence?.synthesisSourceIds,
      webSurfAnswerPlan: webSurfEvidence?.answerIntelligence?.plan,
      webSurfAnswerSources: webSurfEvidence?.answerIntelligence?.sources,
      executionMode: profile.mode,
      modelToolContext: automaticTools.length > 0 ? {
        authenticated: Boolean(ctx.userId && ctx.userId !== "guest"),
        executionMode: profile.mode,
      } : undefined,
      allowedModelTools: automaticTools,
      requiredCapabilities,
    });
    if (result.tool_calls) {
      if (reservation) {
        await billingQuotaService.commit(reservation, { endpoint: "orchestrator", tool: "conversation", outcome: "tool_selected" });
      }
      return executeAutomaticModelToolCalls(result.tool_calls, input, ctx, profile, signal);
    }
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

export async function executeAutomaticModelToolCalls(
  calls: readonly ValidatedToolCall[],
  originalUserRequest: string,
  ctx: BuiltContext,
  profile: ExecutionProfile,
  signal?: AbortSignal,
  onLifecycleEvent?: (event: ToolLifecycleEvent) => void | Promise<void>,
  onFileToken?: (token: string) => void | Promise<void>,
): Promise<StepResult> {
  const allowedTools = getEnabledAutomaticSentIQTools();
  try {
    const dispatched = await dispatchAutomaticModelToolCall<StepResult>({
      calls,
      context: {
        authenticated: Boolean(ctx.userId && ctx.userId !== "guest"),
        executionMode: profile.mode,
      },
      allowedTools,
      executeWebSurf: (query) => execWebSearch(query, ctx, profile, signal, originalUserRequest),
      executeImage: (prompt) => execImageGeneration(prompt, ctx, profile, signal),
      executeChart: (request) => execChartGeneration(request, ctx, signal),
      executeFile: (request, format) => execFileGeneration(
        request,
        ctx,
        format as GeneratedFileFormat | undefined,
        signal,
        onFileToken,
      ),
      executeMemory: (_content, type, scope) => execAutomaticMemoryUpdate(originalUserRequest, type, scope, ctx, profile, signal),
      isFailure: (result, call) => Boolean(result.error)
        || result.image?.success === false
        || result.chart?.success === false
        || result.file?.success === false
        || result.memory?.stored === false
        || (call.name === "web_surf" && !result.web_search),
      onLifecycleEvent,
    });
    return { ...dispatched.result, tool_events: dispatched.events };
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    if (!(error instanceof AutomaticToolDispatchError)) throw error;
    const failure = safeAutomaticToolFailure(error.call);
    return {
      step: 0,
      ...failure,
      error: "Automatic SentIQ tool execution failed.",
      tool_events: error.events,
    };
  }
}

async function execImageGeneration(
  input: string,
  ctx: BuiltContext,
  profile: ExecutionProfile,
  signal?: AbortSignal,
): Promise<StepResult> {
  const localQuota = ctx.imageQuotaKey ? getQuotaInfo(ctx.imageQuotaKey) : undefined;
  if (localQuota?.cooldownActive) {
    throw new Error("Image generation cooldown is active.");
  }
  if (localQuota && localQuota.remaining <= 0) {
    throw new Error("Image generation quota is exhausted.");
  }
  if (ctx.userDb && ctx.conversationId && ctx.clientRequestId) {
    const existing = await findExistingAssistantImageMessage(ctx.userDb, ctx.conversationId, ctx.clientRequestId);
    if (existing?.image_url) {
      return {
        step: 0,
        tool: "image_generation",
        reply: "Generated image.",
        image: {
          success: true,
          image_url: existing.image_url,
          provider_used: existing.provider || undefined,
          prompt: existing.prompt || input,
          persisted: true,
          deduplicated: true,
          storage_path: existing.storage_path || undefined,
          file_size_bytes: existing.file_size_bytes || undefined,
        },
      };
    }
  }
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
    preferredModel = await selectImageModelForCapabilities();
  }

  let result: Awaited<ReturnType<typeof routeImageGeneration>>;
  try {
    const requestKey = createHash("sha256")
      .update(ctx.userId || "guest")
      .update("\0")
      .update(ctx.conversationId || "no-conversation")
      .update("\0")
      .update(ctx.clientRequestId || ctx.billingRequestId || input)
      .update("\0image_gen")
      .digest("hex");
    result = await routeImageGeneration({
      prompt: input,
      userId: ctx.userId,
      signal,
      preferredModel: preferredModel as any,
      requestKey,
    });
    if (result.success && committedReservation) {
      await billingQuotaService.commit(committedReservation, { endpoint: "orchestrator", tool: "image_generation" });
    } else if (!result.success) {
      await releaseBillingReservation(committedReservation ?? reservation);
    }
  } catch (error) {
    await releaseBillingReservation(committedReservation ?? reservation);
    throw error;
  }

  let imageUrl = result.image_url;
  let imageBase64 = result.image_base64;
  let persisted = false;
  let storagePath: string | undefined;
  let fileSizeBytes: number | undefined;
  let persistenceWarning: string | undefined;
  if (result.success && ctx.userDb && ctx.conversationId && (imageBase64 || imageUrl)) {
    try {
      const persistenceResult = await persistGeneratedImageResult({
        userDb: ctx.userDb,
        userId: ctx.userId || "",
        conversationId: ctx.conversationId,
        prompt: input,
        generatedImageData: imageBase64 || imageUrl || "",
        provider: result.provider_used,
        clientRequestId: ctx.clientRequestId,
        storageDb: getImageStorageDatabase(),
        persistPromptMessage: false,
      });
      imageUrl = persistenceResult.assistantMessage.image_url || persistenceResult.storedImage.imageUrl;
      imageBase64 = undefined;
      storagePath = persistenceResult.assistantMessage.storage_path || persistenceResult.storedImage.storagePath;
      fileSizeBytes = persistenceResult.assistantMessage.file_size_bytes || persistenceResult.storedImage.fileSizeBytes;
      persisted = true;
    } catch (error) {
      console.warn(`[IMAGE] automatic persistence degraded: ${error instanceof Error ? error.message : String(error)}`);
      persistenceWarning = "Image was generated, but couldn't be saved to your conversation.";
    }
  }
  if (result.success && ctx.imageQuotaKey) commitImageQuotaSuccess(ctx.imageQuotaKey);

  return {
    step: 0,
    tool: "image_generation",
    reply: result.success
      ? "Generated image."
      : safeImageGenerationFailureMessage(),
    image: {
      success: result.success,
      image_url: imageUrl,
      image_base64: imageBase64,
      provider_used: result.provider_used,
      prompt: result.prompt,
      error: result.success ? undefined : safeImageGenerationFailureMessage(),
      persisted,
      storage_path: storagePath,
      file_size_bytes: fileSizeBytes,
      warning: persistenceWarning,
    },
  };
}

async function execAutomaticMemoryUpdate(
  originalUserMessage: string,
  type: "identity" | "preference" | "project",
  scope: "global" | "chat",
  ctx: BuiltContext,
  profile: ExecutionProfile,
  signal?: AbortSignal,
): Promise<StepResult> {
  throwIfAborted(signal);
  if (!ctx.userId || ctx.userId === "guest" || !ctx.userDb || !ctx.conversationId) {
    throw new Error("Memory updates require an authenticated conversation.");
  }
  if (!ctx.clientRequestId?.trim()) {
    throw new Error("Automatic memory updates require a client request ID.");
  }
  const authorization = enforceAutomaticMemoryScope(
    authorizeAutomaticMemoryUpdate(originalUserMessage),
    scope,
  );
  const candidate = await prepareModelSelectedMemory({
    content: authorization.content,
    type,
    generateEmbedding: profile.persistence.blockOnMemoryEmbedding,
  });
  throwIfAborted(signal);
  const automaticIdempotencyKey = createHash("sha256")
    .update(ctx.userId)
    .update("\0")
    .update(ctx.conversationId)
    .update("\0")
    .update(ctx.clientRequestId)
    .update("\0memory_update")
    .digest("hex");
  const memory = { stored: true as const, ...candidate, scope: authorization.scope, deduplicated: false };
  Object.defineProperty(memory, "automatic_idempotency_key", {
    value: automaticIdempotencyKey,
    enumerable: false,
    writable: false,
  });
  return {
    step: 0,
    tool: "memory_update",
    memory,
  };
}

async function execChartGeneration(
  input: string,
  ctx?: BuiltContext,
  signal?: AbortSignal,
): Promise<StepResult> {
  throwIfAborted(signal);
  if (ctx?.userDb && ctx.conversationId && ctx.clientRequestId) {
    const existing = await getConversationMessageByClientRequestId(ctx.userDb, {
      conversationId: ctx.conversationId,
      clientRequestId: ctx.clientRequestId,
      role: "assistant",
      messageType: "text",
    });
    const chart = existing.data?.preview_json?.chart;
    if (!existing.error && chart?.success === true && typeof chart.chart_type === "string" && typeof chart.renderer === "string") {
      return {
        step: 0,
        tool: "chart_generation",
        reply: existing.data?.content || "Generated chart.",
        chart,
      };
    }
  }
  const result = await routeChartGeneration({
    userMessage: input,
    fetchPreview: true,
    signal,
  });
  throwIfAborted(signal);

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
  requestedFormat?: GeneratedFileFormat,
  signal?: AbortSignal,
  onHtmlToken?: (token: string) => void | Promise<void>,
): Promise<StepResult> {
  throwIfAborted(signal);
  if (ctx.userDb && ctx.conversationId && ctx.clientRequestId) {
    const existing = await getConversationMessageByClientRequestId(ctx.userDb, {
      conversationId: ctx.conversationId,
      clientRequestId: ctx.clientRequestId,
      role: "assistant",
      messageType: "file",
    });
    if (!existing.error && existing.data?.generated_file_id && existing.data.file_name && existing.data.mime_type) {
      return {
        step: 0,
        tool: "file_generation",
        reply: existing.data.content || `Generated ${existing.data.file_name}.`,
        file: {
          type: "file",
          success: true,
          format: existing.data.file_format || requestedFormat || "txt",
          file_name: existing.data.file_name,
          mime_type: existing.data.mime_type,
          file_url: existing.data.file_url || undefined,
          storage_path: existing.data.storage_path || undefined,
          file_size_bytes: existing.data.file_size_bytes || undefined,
          file_id: existing.data.generated_file_id,
          preview: existing.data.preview_json || undefined,
        },
      };
    }
  }
  const result = await routeFileGeneration(
    {
      userMessage: input,
      userId: ctx.userId || "",
      conversationId: ctx.conversationId || "",
      userDb: ctx.userDb,
      requestedFormat,
      signal,
    },
    { onHtmlToken },
  );
  throwIfAborted(signal);

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
  profile: ExecutionProfile,
  signal?: AbortSignal,
  originalUserRequest = input,
): Promise<StepResult> {
  if (isWebSurfV2Enabled()) {
    try {
      const evidence = await prepareWebSurfV2(
        input,
        ctx.webSearchTrigger ?? (ctx.webSearchMode ? "manual" : "auto"),
        {},
        signal,
      );
      // This delegates to the normal conversation executor. It is deliberately
      // the only point that reserves, commits, or releases a text allowance.
      const synthesis = await execConversation(originalUserRequest, ctx, "", profile, signal, evidence);
      return {
        ...synthesis,
        tool: "web_search",
        web_search: {
          query: evidence.payload.query,
          results: [],
          sources: evidence.payload.sources.map((source) => ({ title: source.title, url: source.url })),
          queriesUsed: 1,
          provider: evidence.payload.provider,
          v2: evidence.payload,
        },
      };
    } catch (err) {
      if (signal?.aborted) throwIfAborted(signal);
      if (err instanceof BillingQuotaError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[WebSurfV2] retrieval/synthesis error: ${message}`);
      return {
        step: 0,
        tool: "web_search",
        reply: safeWebSearchFailureMessage(message),
        fallback: true,
      };
    }
  }

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
    switch (planStep.tool) {
      case "web_search":
        result = await execWebSearch(planStep.input, ctx, profile, signal);
        break;
      case "conversation":
        result = await execConversation(planStep.input, ctx, "", profile, signal);
        break;
      default:
        throw new Error(`Planner cannot dispatch ${planStep.tool}; automatic tools require a validated model tool call.`);
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

// ==============================
// Public API
// ==============================

/**
 * Execute the single ordinary-model or explicit-manual-WebSurf plan step.
 * Automatic product tools bypass this plan boundary and require a validated
 * provider-neutral model tool call.
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

  for (let index = 0; index < stepsToExecute.length; index += 1) {
    throwIfAborted(signal);
    const planStep = stepsToExecute[index];

    const result = await executeStep(planStep, ctx, profile, signal);
    results.push(result);
  }

  // Sort results by step number to maintain original order
  results.sort((a, b) => a.step - b.step);

  console.log(`[EXECUTOR] plan complete: ${results.length} steps executed`);
  return { steps: results };
}
