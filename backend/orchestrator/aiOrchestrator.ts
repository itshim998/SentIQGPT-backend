// SentIQ Chat model-native orchestration boundary.
// Context construction and the explicit manual-WebSurf override happen here.
// Automatic product-tool selection happens inside the ordinary model turn.

import { finalizeUserFacingReply } from "../ai/replyGuard";
import { buildContext, buildContextFast } from "../context/contextBuilder";
import { planTask } from "./planner";
import { executePlan } from "./toolExecutor";
import { PRODUCT_DISCLAIMER } from "../branding";
import type { RawMessageContext } from "../context/contextBuilder";
import type { PlanTool } from "./planner";
import type { StepResult } from "./toolExecutor";
import type { SearchResult } from "../tools/webSearch/types";
import type { WebSurfV2Payload } from "../tools/webSearch/webSurfV2";
import type { ToolLifecycleEvent } from "./toolContract";
import { resolveExecutionProfile, type ExecutionMode, type ExecutionProfile } from "./executionProfile";

export type DetectedTool =
  | "normal_chat"
  | "file_analysis"
  | "memory_update"
  | "chart_generation"
  | "file_generation"
  | "web_search"
  | "image_generation"
  | "math_reasoning"
  | "knowledge_query";

// ==============================
// Types
// ==============================

export interface OrchestratorRequest {
  readonly userMessage: string;
  readonly context?: RawMessageContext;
  readonly executionMode?: ExecutionMode;
  readonly signal?: AbortSignal;
}

export interface OrchestratorResponse {
  /** Which handler processed the request */
  readonly route: DetectedTool;
  /** Primary user-facing answer */
  readonly answer?: string;
  /** Text reply (for chat/file_analysis) */
  readonly reply?: string;
  /** Optional extracted internal reasoning */
  readonly thinking?: string;
  /** Standard AI disclaimer */
  readonly disclaimer?: string;
  /** Image result (for image_generation) */
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
  /** Chart result (for chart_generation) */
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
  /** Generated downloadable file result */
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
  /** Memory pipeline result */
  readonly memory: {
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
  /** Web search payload (for structured rendering) */
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
  /** Response confidence estimate */
  readonly confidence: number;
  /** Primary model/provider used for the response when known */
  readonly model_used?: string;
  /** True when the response used live web search */
  readonly searched?: boolean;
  readonly tool_events?: readonly ToolLifecycleEvent[];
}

type InternalMergedResponse = Omit<OrchestratorResponse, "confidence"> & {
  _isMathResult?: boolean;
  _model_used?: string;
  _fallback?: boolean;
  _sanitize_bypass?: boolean;
};

// ==============================
// Helpers
// ==============================

/** Map the executed step to the public response route. */
function planToolToRoute(tool: PlanTool): DetectedTool {
  switch (tool) {
    case "image_generation": return "image_generation";
    case "file_analysis":    return "file_analysis";
    case "memory_update":    return "memory_update";
    case "chart_generation": return "chart_generation";
    case "file_generation":  return "file_generation";
    case "web_search":       return "web_search";
    case "conversation":
    default:                 return "normal_chat";
  }
}

function getBaseModelConfidence(model: string): number {
  const normalized = model.trim().toLowerCase();
  if (normalized === "openai-large") return 0.9;
  if (normalized === "gemini" || normalized.startsWith("gemini")) return 0.8;
  if (normalized === "qwen-coder" || normalized.startsWith("qwen-coder")) return 0.75;
  return 0.7;
}

function computeConfidence(
  model_used?: string,
  fallback?: boolean,
  reply?: string,
): number {
  const safeModel = model_used?.trim() ? model_used : "unknown";
  let confidence = getBaseModelConfidence(safeModel);

  if (fallback) {
    confidence -= 0.15;
  }

  if (!reply || reply.trim().length < 20) {
    confidence -= 0.1;
  } else {
    confidence += 0.05;
  }

  confidence = Math.max(0.3, Math.min(0.95, confidence));

  if (!Number.isFinite(confidence)) {
    confidence = 0.3;
  }

  console.log("[CONFIDENCE]", {
    model: safeModel,
    fallback: !!fallback,
    final: confidence,
  });

  return confidence;
}

function createOrchestratorAbortSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Orchestration timed out after ${timeoutMs / 1000}s`));
  }, timeoutMs);
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason ?? new Error("Orchestration aborted"));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Orchestration aborted");
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Orchestration aborted"));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason instanceof Error ? signal.reason : new Error("Orchestration aborted")),
      { once: true },
    );
  });
}

function buildContextForProfile(
  profile: ExecutionProfile,
  rawContext: RawMessageContext | undefined,
  userMessage: string,
) {
  const raw = { ...(rawContext ?? {}), userMessage };
  const options = { profile };
  return profile.context.compressConversation
    ? buildContext(raw, rawContext?.userDb, rawContext?.userId, options)
    : buildContextFast(raw, rawContext?.userDb, rawContext?.userId, options);
}

export function finalizeReply(
  reply?: string,
  emptyFallback = "Sorry, something went wrong. Please try again.",
  sanitizeBypass = false,
): string {
  return finalizeUserFacingReply(reply, {
    emptyFallback,
    sanitizeMode: sanitizeBypass ? "none" : "strict",
  });
}

/** Merge multi-step results into a single OrchestratorResponse. */
export function mergeResults(
  steps: readonly StepResult[],
  memoryPayload: OrchestratorResponse["memory"],
): InternalMergedResponse {
  let reply: string | undefined;
  let thinking: string | undefined;
  let image: OrchestratorResponse["image"] | undefined;
  let chart: OrchestratorResponse["chart"] | undefined;
  let file: OrchestratorResponse["file"] | undefined;
  let memory = memoryPayload;
  let web_search: OrchestratorResponse["web_search"] | undefined;
  let route: DetectedTool = "normal_chat";
  let _isMathResult = false;
  let _model_used: string | undefined;
  let _fallback = false;
  let _sanitize_bypass = false;
  const tool_events: ToolLifecycleEvent[] = [];

  const replyParts: string[] = [];
  const thinkingParts: string[] = [];

  for (const step of steps) {
    // Track the primary route from the first step
    if (step.step === 1) {
      route = planToolToRoute(step.tool);
    }

    // Detect math pipeline results
    if (step.isMathResult) {
      _isMathResult = true;
      route = "math_reasoning" as DetectedTool;
    }

    if (step.reply) {
      replyParts.push(step.reply);
      _model_used = step.model_used ?? _model_used;
      _fallback = step.fallback ?? _fallback;
    }

    if (step.sanitize_bypass) {
      _sanitize_bypass = true;
    }

    if (step.thinking && step.thinking.trim()) {
      thinkingParts.push(step.thinking.trim());
    }

    if (step.image) {
      image = step.image;
      // If the primary step was not image, upgrade route
      if (!image.error && image.success) {
        route = "image_generation";
      }
    }

    if (step.chart) {
      chart = step.chart;
      if (!chart.error && chart.success) {
        route = "chart_generation";
      }
    }

    if (step.file) {
      file = step.file;
      _model_used = step.file.model_used ?? step.model_used ?? _model_used;
      _fallback = step.file.fallback ?? step.fallback ?? _fallback;
      if (!file.error && file.success) {
        route = "file_generation";
      }
    }

    if (step.memory?.stored) {
      memory = {
        ...step.memory,
        stored: true,
      };
    } else if (step.memory) {
      memory = {
        stored: false,
        failure_reason: step.memory.failure_reason,
      };
    }

    if (step.web_search) {
      web_search = step.web_search;
    }
    if (step.tool_events) tool_events.push(...step.tool_events);
  }

  if (replyParts.length > 0) {
    reply = replyParts.join("\n\n");
  }

  if (thinkingParts.length > 0) {
    thinking = thinkingParts.join("\n\n");
  }

  return {
    route,
    answer: reply,
    reply,
    thinking,
    disclaimer: reply
      ? PRODUCT_DISCLAIMER
      : undefined,
    image,
    chart,
    file,
    memory,
    web_search,
    tool_events: tool_events.length > 0 ? tool_events : undefined,
    _isMathResult,
    _model_used,
    _fallback,
    _sanitize_bypass,
  };
}

// ==============================
// Orchestrator
// ==============================

/**
 * Main orchestration function.
 *
 * Builds context alongside the one-step execution boundary, then runs either
 * the ordinary tool-capable model turn or explicit manual WebSurf.
 */
export async function orchestrate(
  request: OrchestratorRequest,
): Promise<OrchestratorResponse> {
  const timeoutMs = 120_000;
  const abort = createOrchestratorAbortSignal(request.signal, timeoutMs);
  try {
    return await Promise.race([
      _orchestrateInner({ ...request, signal: abort.signal }),
      waitForAbort(abort.signal),
    ]);
  } finally {
    abort.cleanup();
  }
}

async function _orchestrateInner(
  request: OrchestratorRequest,
): Promise<OrchestratorResponse> {
  const profile = resolveExecutionProfile(request.executionMode);
  const signal = request.signal;
  throwIfAborted(signal);
  const { context: rawContext } = request;
  const userMessage = request.userMessage;

  console.log(`[ORCHESTRATOR] Processing: "${userMessage.slice(0, 80)}..." (mode=${profile.mode})`);


  throwIfAborted(signal);

  // 1. Build context and the one-step execution boundary in parallel.
  const [ctx, plan] = await Promise.all([
    buildContextForProfile(profile, rawContext, userMessage),
    planTask({
      userMessage,
      hasFileContext: (rawContext?.file_references?.length ?? 0) > 0,
      userId: rawContext?.userId,
      explicitWebSearchMode: rawContext?.web_search_mode,
      executionMode: profile.mode,
    }),
  ]);
  throwIfAborted(signal);

  console.log(`[ORCHESTRATOR] plan: ${plan.steps.length} step(s)`);

  // 2. Execute the plan
  const execution = await executePlan(plan.steps, ctx, { profile, signal });
  throwIfAborted(signal);

  // 3. Merge step results into a single response
  const merged = mergeResults(execution.steps, { stored: false });

  // 4. Normalize the user-facing terminal result without another model call.
  const finalReply =
    merged._isMathResult
      ? (merged.reply?.trim() || "Sorry, something went wrong. Please try again.")
      : merged.reply !== undefined
      ? finalizeReply(merged.reply, undefined, merged._sanitize_bypass === true)
      : merged.route === "memory_update" && merged.memory.stored
        ? finalizeReply(undefined, "Got it. I've remembered that.")
        : merged.route === "memory_update"
          ? finalizeReply(
              undefined,
              "I couldn't store that memory. Please phrase it as something to remember about your identity, preferences, or project.",
            )
        : finalizeReply(undefined);
  const computedConfidence = computeConfidence(
    merged._model_used,
    merged._fallback,
    finalReply,
  );
  const { _isMathResult, _model_used, _fallback, ...publicMerged } = merged;
  void _isMathResult;
  void _fallback;

  const finalResponse: OrchestratorResponse = {
    ...publicMerged,
    answer: finalReply,
    reply: finalReply,
    thinking: merged.thinking,
    confidence: computedConfidence,
    model_used: _model_used,
    searched: merged.route === "web_search" || Boolean(merged.web_search),
  };

  return finalResponse;
}
