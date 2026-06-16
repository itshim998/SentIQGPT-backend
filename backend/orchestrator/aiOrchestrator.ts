// SentIQ Chat v2 — AI Orchestrator (with Autonomous Tool Selection)
//
// Central intelligence pipeline. The orchestrator:
//
//   1. Builds compressed context (conversation window + semantic memories)
//   2. Runs the Task Planner (Groq)
//   3. Hands the execution plan to the Tool Executor
//   4. Merges multi-step results into a single OrchestratorResponse
//
//   User Message
//       ├── Task Planner (Groq, fast)       → ExecutionPlan (1–3 steps)
//       └── Context Builder (async)
//               └── Tool Executor
//                     ├── conversation      → ChatHandler (Gemini)
//                     ├── image_generation   → Image Router
//                     ├── file_analysis      → ChatHandler + file context
//                     └── memory_update      → Explicit memory storage
//
//   5. Self-Reflection Loop
//        └── Answer Critic (Groq) → optional Answer Improver (Gemini)
//   6. Knowledge Cache Layer
//        └── LLM answer cache (check before pipeline, store after reflection)

import { finalizeUserFacingReply } from "../ai/replyGuard";
import { buildContext, buildContextFast } from "../context/contextBuilder";
import { planTask } from "./planner";
import { executePlan } from "./toolExecutor";
import { detectExplicitMemoryWriteIntent } from "./queryClassifier";
import {
  DEFAULT_MAX_CLARIFICATION_TURNS,
  formatClarificationText,
  maybeCreateClarification,
  resolveClarificationInput,
  type ClarificationPayload,
  type ClarificationOption,
  type ClarificationResponsePayload,
} from "./intentClarifier";
import { evaluateAnswer } from "../reflection/answerCritic";
import { PRODUCT_DISCLAIMER } from "../branding";
import { improveAnswer } from "../reflection/answerImprover";
import type { RawMessageContext } from "../context/contextBuilder";
import type { DetectedTool } from "./toolDetector";
import type { PlanTool } from "./planner";
import type { StepResult } from "./toolExecutor";
import type { SearchResult } from "../tools/webSearch/types";
import { resolveExecutionProfile, type ExecutionMode, type ExecutionProfile } from "./executionProfile";

// ==============================
// Types
// ==============================

export interface OrchestratorRequest {
  readonly userMessage: string;
  readonly context?: RawMessageContext;
  readonly executionMode?: ExecutionMode;
  readonly clarificationResponse?: ClarificationResponsePayload;
  readonly signal?: AbortSignal;
  /** Skip reflection loop for faster response (default: false) */
  readonly skipReflection?: boolean;
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
  };
  /** Intent clarification payload for interactive follow-up UI */
  readonly clarification?: ClarificationPayload;
  /** Self-reflection evaluation (if run) */
  readonly reflection?: {
    score: number;
    issues: readonly string[];
    improved: boolean;
  };
  /** Tool detection confidence */
  readonly confidence: number;
  /** Primary model/provider used for the response when known */
  readonly model_used?: string;
  /** True when the response used live web search */
  readonly searched?: boolean;
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

/** Map planner tool names to the legacy DetectedTool union. */
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

function buildClarificationResponse(payload: ClarificationPayload): OrchestratorResponse {
  const reply = formatClarificationText(payload);
  return {
    route: "clarification" as DetectedTool,
    answer: reply,
    reply,
    disclaimer: PRODUCT_DISCLAIMER,
    memory: { stored: false },
    clarification: payload,
    confidence: 0.9,
    model_used: payload.model_used,
    searched: false,
  };
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

async function maybeClarify(
  userMessage: string,
  rawContext: RawMessageContext | undefined,
  currentTurn: number,
  options: {
    webSearch?: boolean;
    originalMessage?: string;
    previousAnswers?: readonly string[];
    answeredQuestion?: string;
    answeredOptions?: readonly ClarificationOption[];
    selectedOptionId?: string;
  } = {},
): Promise<OrchestratorResponse | null> {
  const fileReferences = rawContext?.file_references ?? [];
  const imageAttachments = rawContext?.image_attachments ?? [];
  const clarification = await maybeCreateClarification({
    userMessage,
    originalMessage: options.originalMessage,
    previousAnswers: options.previousAnswers,
    userId: rawContext?.userId,
    isGuest: rawContext?.userId === "guest",
    hasFile: fileReferences.length > 0,
    hasImage: imageAttachments.length > 0,
    fileNames: fileReferences.map((file) => file.filename),
    fileContent: fileReferences.map((file) => file.extractedText).join("\n"),
    trustedProfileName: rawContext?.trustedProfile?.displayName,
    webSearch: options.webSearch === true,
    currentTurn,
    maxTurns: DEFAULT_MAX_CLARIFICATION_TURNS,
    answeredQuestion: options.answeredQuestion,
    answeredOptions: options.answeredOptions,
    selectedOptionId: options.selectedOptionId,
  });
  return clarification ? buildClarificationResponse(clarification) : null;
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
 * Runs the Task Planner alongside context building for speed,
 * then hands the execution plan to the Tool Executor.
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
  const skipReflection = request.skipReflection ?? !profile.reflection.enabled;
  const resolvedClarification = resolveClarificationInput(
    request.userMessage,
    request.clarificationResponse,
  );
  const userMessage = resolvedClarification.effectiveMessage;

  console.log(`[ORCHESTRATOR] Processing: "${userMessage.slice(0, 80)}..." (mode=${profile.mode}, skipReflection=${skipReflection})`);


  // ── Early Math Detection ──
  // Math detection MUST run on the raw userMessage, not the planner-rewritten
  // input. The planner (Groq) compresses/summarizes the query, which strips
  // numerical context and causes word problems to be misclassified as general chat.
  // When math is detected, we bypass the planner entirely and go straight to
  // the openai-large math pipeline.
  if (detectExplicitMemoryWriteIntent(userMessage)) {
    console.log(`[ORCHESTRATOR] explicit memory write detected — bypassing planner`);
    const ctx = await buildContextForProfile(profile, rawContext, userMessage);
    const execution = await executePlan(
      [{ step: 1, tool: "memory_update", input: userMessage }],
      ctx,
      { profile, signal },
    );
    const merged = mergeResults(execution.steps, { stored: false });
    const reply = merged.memory.stored
      ? "Got it. I've remembered that."
      : "I couldn't store that memory. Please phrase it as something to remember about your identity, preferences, or project.";
    const confidence = computeConfidence("memory_update", false, merged.memory.stored ? reply : "");

    return {
      route: "memory_update",
      answer: reply,
      reply,
      disclaimer: PRODUCT_DISCLAIMER,
      memory: merged.memory,
      confidence,
    };
  }

  const maybeWebSearchRequest = Boolean(rawContext?.web_search_mode);

  if (profile.clarification.enabled && !maybeWebSearchRequest) {
    const clarificationResponse = await maybeClarify(
      userMessage,
      rawContext,
      resolvedClarification.turn,
      {
        originalMessage: resolvedClarification.originalMessage,
        previousAnswers: resolvedClarification.answers,
        answeredQuestion: resolvedClarification.answeredQuestion,
        answeredOptions: resolvedClarification.answeredOptions,
        selectedOptionId: resolvedClarification.selectedOptionId,
      },
    );
    if (clarificationResponse) {
      return clarificationResponse;
    }
  }
  throwIfAborted(signal);

  // 1. Build context + run planner in PARALLEL (both are independent)
  //    Memory pipeline is deferred to background — never blocks the LLM response.
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
  let finalPlan = plan;
  const firstStep = finalPlan.steps[0];
  const isWebSearchPlan = firstStep?.tool === "web_search";
  let execution: Awaited<ReturnType<typeof executePlan>>;
  if (isWebSearchPlan) {
    const clarificationResponse = profile.clarification.enabled
      ? await maybeClarify(
          userMessage,
          rawContext,
          resolvedClarification.turn,
          {
            webSearch: true,
            originalMessage: resolvedClarification.originalMessage,
            previousAnswers: resolvedClarification.answers,
            answeredQuestion: resolvedClarification.answeredQuestion,
            answeredOptions: resolvedClarification.answeredOptions,
            selectedOptionId: resolvedClarification.selectedOptionId,
          },
        )
      : null;
    if (clarificationResponse) {
      return clarificationResponse;
    }
    throwIfAborted(signal);
    execution = await executePlan(finalPlan.steps, ctx, { profile, signal });
  } else {
    execution = await executePlan(finalPlan.steps, ctx, { profile, signal });
  }
  throwIfAborted(signal);

  // 3. Merge step results into a single response
  const merged = mergeResults(execution.steps, { stored: false });

  // 3b. Self-Reflection Loop (OPTIONAL for performance)
  //     Only runs when:
  //       - skipReflection is false (default)
  //       - Text replies ≥ 100 chars
  //     Always skips:
  //       - image-only, memory-only, short responses
  //       - math queries (handled by direct math pipeline)
  let reflected: { merged: InternalMergedResponse; reflection?: OrchestratorResponse["reflection"] };
  
  if (skipReflection) {
    console.log("[REFLECTION] skipped per request (skipReflection=true)");
    reflected = { merged };
  } else {
    reflected = await reflectOnAnswer(
      userMessage,
      merged,
      merged._isMathResult,
      rawContext?.userId,
    );
  }

  const finalReply =
    reflected.merged._isMathResult
      ? (reflected.merged.reply?.trim() || "Sorry, something went wrong. Please try again.")
      : reflected.merged.reply !== undefined
      ? finalizeReply(reflected.merged.reply, undefined, reflected.merged._sanitize_bypass === true)
      : reflected.merged.route === "memory_update" && reflected.merged.memory.stored
        ? finalizeReply(undefined, "Got it. I've remembered that.")
        : reflected.merged.route === "memory_update"
          ? finalizeReply(
              undefined,
              "I couldn't store that memory. Please phrase it as something to remember about your identity, preferences, or project.",
            )
        : finalizeReply(undefined);
  const computedConfidence = computeConfidence(
    reflected.merged._model_used,
    reflected.merged._fallback,
    finalReply,
  );
  const { _isMathResult, _model_used, _fallback, ...publicMerged } = reflected.merged;
  void _isMathResult;
  void _fallback;

  const finalResponse: OrchestratorResponse = {
    ...publicMerged,
    answer: finalReply,
    reply: finalReply,
    thinking: reflected.merged.thinking,
    reflection: reflected.reflection,
    confidence: computedConfidence,
    model_used: _model_used,
    searched: reflected.merged.route === "web_search" || Boolean(reflected.merged.web_search),
  };

  return finalResponse;
}

// ==============================
// Self-Reflection
// ==============================

const MIN_REFLECTION_LENGTH = 100;

/**
 * Run the self-reflection loop on a merged response.
 *
 * Skips reflection when:
 *   • No text reply exists (image/memory-only)
 *   • Reply is shorter than MIN_REFLECTION_LENGTH
 *   • Route is image_generation (tool output, not prose)
 *   • Route is chart_generation
 *   • Query was handled by the math pipeline
 */
async function reflectOnAnswer(
  userMessage: string,
  merged: InternalMergedResponse,
  isMathResult?: boolean,
  userId?: string,
): Promise<{
  merged: InternalMergedResponse;
  reflection?: OrchestratorResponse["reflection"];
}> {
  // Guard: skip for non-text or short replies
  if (
    !merged.reply ||
    merged.reply.length < MIN_REFLECTION_LENGTH ||
    merged._sanitize_bypass === true ||
    merged.route === "image_generation" ||
    merged.route === "chart_generation" ||
    merged.route === "file_generation" ||
    merged.route === "web_search" // Skip reflection for web search (already synthesized)
  ) {
    return { merged };
  }

  // Guard: skip for math queries — already handled by the math pipeline
  if (isMathResult) {
    console.log("[MathPipeline] reflection skipped — math query already handled by direct math pipeline");
    return { merged };
  }

  try {
    // Critic pass (Groq — fast & cheap)
    const evaluation = await evaluateAnswer(userMessage, merged.reply, userId);

    console.log(`[REFLECTION] score: ${evaluation.score.toFixed(2)}`);
    console.log(`[REFLECTION] issues detected: ${evaluation.issues.length}`);

    if (!evaluation.improve) {
      console.log("[REFLECTION] quality sufficient, skipping improvement");
      return {
        merged,
        reflection: {
          score: evaluation.score,
          issues: evaluation.issues,
          improved: false,
        },
      };
    }

    // Improvement pass (Gemini — high quality)
    const result = await improveAnswer(userMessage, merged.reply, evaluation, userId);

    if (result.improved) {
      console.log("[REFLECTION] improvement applied");
    }

    return {
      merged: result.improved
        ? {
            ...merged,
            reply: result.answer,
            _model_used: result.model_used ?? merged._model_used ?? "unknown",
            _fallback: result.fallback ?? false,
          }
        : merged,
      reflection: {
        score: evaluation.score,
        issues: evaluation.issues,
        improved: result.improved,
      },
    };
  } catch (err) {
    console.log(`[REFLECTION] loop failed: ${err instanceof Error ? err.message : err}`);
    return { merged };
  }
}
