// SentIQGPT v2 — AI Orchestrator (with Autonomous Tool Selection)
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

import { solveMathDirect } from "../ai/mathVerifier";
import { sanitizeResponse } from "../ai/responseSanitizer";
import { buildContext } from "../context/contextBuilder";
import { planTask } from "./planner";
import { executePlan } from "./toolExecutor";
import { detectCodeQuery, isMathQuery } from "./modelRouter";
import { detectExplicitMemoryWriteIntent } from "./queryClassifier";
import { evaluateAnswer } from "../reflection/answerCritic";
import { improveAnswer } from "../reflection/answerImprover";
import type { RawMessageContext } from "../context/contextBuilder";
import type { DetectedTool } from "./toolDetector";
import type { PlanTool } from "./planner";
import type { StepResult } from "./toolExecutor";

// ==============================
// Types
// ==============================

export interface OrchestratorRequest {
  readonly userMessage: string;
  readonly context?: RawMessageContext;
}

export interface OrchestratorResponse {
  /** Which handler processed the request */
  readonly route: DetectedTool;
  /** Text reply (for chat/file_analysis) */
  readonly reply?: string;
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
  /** Memory pipeline result */
  readonly memory: {
    stored: boolean;
    type?: string;
    summary?: string;
    importance?: number;
  };
  /** Self-reflection evaluation (if run) */
  readonly reflection?: {
    score: number;
    issues: readonly string[];
    improved: boolean;
  };
  /** Tool detection confidence */
  readonly confidence: number;
}

type InternalMergedResponse = Omit<OrchestratorResponse, "confidence"> & {
  _isMathResult?: boolean;
  _model_used?: string;
  _fallback?: boolean;
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
    case "conversation":
    default:                 return "normal_chat";
  }
}

function getBaseModelConfidence(model: string): number {
  const normalized = model.trim().toLowerCase();
  if (normalized === "deepseek") return 0.9;
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

function finalizeReply(
  reply?: string,
  emptyFallback = "Sorry, something went wrong. Please try again.",
): string {
  const cleanedReply = reply ? sanitizeResponse(reply) : emptyFallback;
  if (!cleanedReply || cleanedReply.trim().length < 5) {
    return "Sorry, something went wrong. Please try again.";
  }
  return cleanedReply;
}

/** Merge multi-step results into a single OrchestratorResponse. */
function mergeResults(
  steps: readonly StepResult[],
  memoryPayload: OrchestratorResponse["memory"],
): InternalMergedResponse {
  let reply: string | undefined;
  let image: OrchestratorResponse["image"] | undefined;
  let chart: OrchestratorResponse["chart"] | undefined;
  let memory = memoryPayload;
  let route: DetectedTool = "normal_chat";
  let _isMathResult = false;
  let _model_used: string | undefined;
  let _fallback = false;

  const replyParts: string[] = [];

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

    if (step.memory?.stored) {
      memory = {
        stored: true,
        type: step.memory.type,
        summary: step.memory.summary,
        importance: step.memory.importance,
      };
    }
  }

  if (replyParts.length > 0) {
    reply = replyParts.join("\n\n");
  }

  return {
    route,
    reply,
    disclaimer: reply
      ? "SentIQGPT is an AI assistant. Verify important information independently."
      : undefined,
    image,
    chart,
    memory,
    _isMathResult,
    _model_used,
    _fallback,
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
  // Wrap entire pipeline in a 120s hard timeout to prevent infinite hangs
  const timeoutMs = 120_000;
  const result = await Promise.race([
    _orchestrateInner(request),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Orchestration timed out after 120s")), timeoutMs),
    ),
  ]);
  return result;
}

async function _orchestrateInner(
  request: OrchestratorRequest,
): Promise<OrchestratorResponse> {
  const { userMessage, context: rawContext } = request;

  console.log(`[ORCHESTRATOR] Processing: "${userMessage.slice(0, 80)}..."`);


  // ── Early Math Detection ──
  // Math detection MUST run on the raw userMessage, not the planner-rewritten
  // input. The planner (Groq) compresses/summarizes the query, which strips
  // numerical context and causes word problems to be misclassified as general chat.
  // When math is detected, we bypass the planner entirely and go straight to
  // the DeepSeek math pipeline.
  if (detectExplicitMemoryWriteIntent(userMessage)) {
    console.log(`[ORCHESTRATOR] explicit memory write detected — bypassing planner`);
    const ctx = await buildContext({ ...(rawContext ?? {}), userMessage });
    const execution = await executePlan(
      [{ step: 1, tool: "memory_update", input: userMessage }],
      ctx,
    );
    const merged = mergeResults(execution.steps, { stored: false });
    const reply = merged.memory.stored
      ? "Got it. I've remembered that."
      : "I couldn't store that memory. Please phrase it as something to remember about your identity, preferences, or project.";
    const confidence = computeConfidence("memory_update", false, merged.memory.stored ? reply : "");

    return {
      route: "memory_update",
      reply,
      disclaimer: "SentIQGPT is an AI assistant. Verify important information independently.",
      memory: merged.memory,
      confidence,
    };
  }

  const isCodingQuery = detectCodeQuery(userMessage);

  if (!isCodingQuery && isMathQuery(userMessage)) {
    console.log(`[MathPipeline] math query detected on raw input — bypassing planner`);
    console.log(`[MathPipeline] solving with deepseek`);

    const systemPrompt =
      "SYSTEM: You are solving a mathematical problem.\n" +
      "STRICT OUTPUT RULES:\n" +
      "- DO NOT include your thinking process\n" +
      "- DO NOT say 'I will solve' or 'Let's solve'\n" +
      "- DO NOT explain your reasoning in paragraphs\n" +
      "- ONLY provide the final structured solution\n" +
      "FORMAT:\n" +
      "1. Define variables (if needed)\n" +
      "2. Write constraints / equations clearly\n" +
      "3. Key observation (if any contradiction or insight exists)\n" +
      "4. Final conclusion\n" +
      "5. Final answer\n" +
      "RULES:\n" +
      "- Keep explanations minimal and precise\n" +
      "- Use clean step-by-step format\n" +
      "- No unnecessary words\n" +
      "- No repetition\n" +
      "- No meta statements";

    const mathResult = await solveMathDirect(userMessage, systemPrompt);

    console.log(
      `[MathPipeline] solved using deepseek`,
    );
    console.log(`[MathPipeline] reflection skipped — math query handled by direct math pipeline`);
    console.log(`[MathPipeline] returning result`);

    const finalReply = finalizeReply(mathResult.answer);
    const computedConfidence = computeConfidence(
      mathResult.model_used,
      mathResult.fallback,
      finalReply,
    );

    return {
      route: "math_reasoning" as DetectedTool,
      reply: finalReply,
      disclaimer: "SentIQGPT is an AI assistant. Verify important information independently.",
      memory: { stored: false },
      confidence: computedConfidence,
    };
  }

  // 1. Build context + run planner in PARALLEL (both are independent)
  //    Memory pipeline is deferred to background — never blocks the LLM response.
  const [ctx, plan] = await Promise.all([
    buildContext({ ...(rawContext ?? {}), userMessage }),
    planTask({ userMessage, hasFileContext: (rawContext?.file_references?.length ?? 0) > 0 }),
  ]);

  console.log(`[ORCHESTRATOR] plan: ${plan.steps.length} step(s)`);

  // 2. Execute the plan
  let finalPlan = plan;
  const execution = await executePlan(finalPlan.steps, ctx);

  // 3. Merge step results into a single response
  const merged = mergeResults(execution.steps, { stored: false });

  // 3b. Self-Reflection Loop
  //     Only runs on text replies ≥ 100 chars.
  //     Skips image-only, memory-only, short responses, AND math results
  //     (math queries are already handled by the direct math pipeline).
  const reflected = await reflectOnAnswer(userMessage, merged, merged._isMathResult);

  const finalReply =
    reflected.merged.reply !== undefined
      ? finalizeReply(reflected.merged.reply)
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
  void _model_used;
  void _fallback;

  const finalResponse: OrchestratorResponse = {
    ...publicMerged,
    reply: finalReply,
    reflection: reflected.reflection,
    confidence: computedConfidence,
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
): Promise<{
  merged: InternalMergedResponse;
  reflection?: OrchestratorResponse["reflection"];
}> {
  // Guard: skip for non-text or short replies
  if (
    !merged.reply ||
    merged.reply.length < MIN_REFLECTION_LENGTH ||
    merged.route === "image_generation" ||
    merged.route === "chart_generation"
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
    const evaluation = await evaluateAnswer(userMessage, merged.reply);

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
    const result = await improveAnswer(userMessage, merged.reply, evaluation);

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
