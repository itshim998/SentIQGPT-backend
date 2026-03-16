// SentIQGPT v2 — AI Orchestrator (with Autonomous Tool Selection)
//
// Central intelligence pipeline. The orchestrator:
//
//   1. Builds compressed context (conversation window + semantic memories)
//   2. Runs the Task Planner (Groq) + Memory Pipeline in PARALLEL
//   3. Hands the execution plan to the Tool Executor
//   4. Merges multi-step results into a single OrchestratorResponse
//
//   User Message
//       ├── Task Planner (Groq, fast)       → ExecutionPlan (1–3 steps)
//       ├── Memory Pipeline (Groq, parallel)
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

import { handleChat } from "../ai/ChatHandler";
import { processMessageForMemory } from "../ai/MemoryProcessor";
import { verifyMathAnswer } from "../ai/mathVerifier";
import { buildContext } from "../context/contextBuilder";
import { planTask } from "./planner";
import { executePlan } from "./toolExecutor";
import { isMathQuery } from "./modelRouter";
import { evaluateAnswer } from "../reflection/answerCritic";
import { improveAnswer } from "../reflection/answerImprover";
import { getCachedAnswer, setCachedAnswer } from "../cache/cacheManager";
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

/** Merge multi-step results into a single OrchestratorResponse. */
function mergeResults(
  steps: readonly StepResult[],
  memoryPayload: OrchestratorResponse["memory"],
): Omit<OrchestratorResponse, "confidence"> & { _isMathResult?: boolean } {
  let reply: string | undefined;
  let image: OrchestratorResponse["image"] | undefined;
  let chart: OrchestratorResponse["chart"] | undefined;
  let memory = memoryPayload;
  let route: DetectedTool = "normal_chat";
  let _isMathResult = false;

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
  };
}

// ==============================
// Orchestrator
// ==============================

/**
 * Main orchestration function.
 *
 * Runs the Task Planner and Memory Pipeline in parallel for speed,
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

  // 0. Check LLM answer cache
  const hasRawFiles = (rawContext?.file_references?.length ?? 0) > 0;
  if (!hasRawFiles) {
    const cachedReply = getCachedAnswer(userMessage);
    if (cachedReply) {
      console.log(`[ORCHESTRATOR] returning cached answer`);
      return {
        route: "normal_chat",
        reply: cachedReply,
        disclaimer: "SentIQGPT is an AI assistant. Verify important information independently.",
        memory: { stored: false },
        confidence: 1.0,
      };
    }
  }

  // ── Early Math Detection ──
  // Math detection MUST run on the raw userMessage, not the planner-rewritten
  // input. The planner (Groq) compresses/summarizes the query, which strips
  // numerical context and causes word problems to be misclassified as general chat.
  // When math is detected, we bypass the planner entirely and go straight to
  // the DeepSeek math pipeline.
  if (isMathQuery(userMessage)) {
    console.log(`[MathPipeline] math query detected on raw input — bypassing planner`);
    console.log(`[MathPipeline] solving with deepseek`);

    const systemPrompt =
      "SYSTEM: You are SentIQGPT, a knowledgeable and helpful AI assistant.\n" +
      "Provide clear, step-by-step mathematical reasoning.\n" +
      "Show your work and verify your calculations.";

    // Run math pipeline + memory in parallel
    let memoryPayload: OrchestratorResponse["memory"] = { stored: false };
    const [mathResult] = await Promise.all([
      verifyMathAnswer(userMessage, systemPrompt),
      processMessageForMemory({
        message: userMessage,
        recentMessages: [],
        existingMemories: [],
      })
        .then((memResult) => {
          if (memResult.stored) {
            memoryPayload = {
              stored: true,
              type: memResult.memory?.type,
              summary: memResult.memory?.summary,
              importance: memResult.memory?.importance,
            };
          }
        })
        .catch((err) => {
          console.log(`[MathPipeline] memory pipeline error: ${err instanceof Error ? err.message : err}`);
        }),
    ]);

    console.log(
      `[MathPipeline] result — verified=${mathResult.verified} agreed=${mathResult.agreed} reconciled=${mathResult.reconciled}`,
    );
    console.log(`[MathPipeline] reflection skipped — math query already verified`);
    console.log(`[MathPipeline] returning result`);

    return {
      route: "math_reasoning" as DetectedTool,
      reply: mathResult.answer,
      disclaimer: "SentIQGPT is an AI assistant. Verify important information independently.",
      memory: memoryPayload,
      confidence: 1.0,
    };
  }

  // 1. Build context + run planner in PARALLEL (both are independent)
  //    Memory pipeline is deferred to background — never blocks the LLM response.
  const [ctx, plan] = await Promise.all([
    buildContext({ ...(rawContext ?? {}), userMessage }),
    planTask({ userMessage, hasFileContext: (rawContext?.file_references?.length ?? 0) > 0 }),
  ]);

  console.log(`[ORCHESTRATOR] plan: ${plan.steps.length} step(s)`);

  // Fire memory pipeline in background — safe error handling
  let memoryPayload: OrchestratorResponse["memory"] = { stored: false };
  const memoryPromise = processMessageForMemory({
    message: userMessage,
    recentMessages: [...ctx.recentMessages],
    existingMemories: [...ctx.memories],
  })
    .then((memResult) => {
      if (memResult.stored) {
        memoryPayload = {
          stored: true,
          type: memResult.memory?.type,
          summary: memResult.memory?.summary,
          importance: memResult.memory?.importance,
        };
      }
      console.log(`[ORCHESTRATOR] memory stored: ${memResult.stored}`);
    })
    .catch((err) => {
      console.log(`[ORCHESTRATOR] memory pipeline error: ${err instanceof Error ? err.message : err}`);
    });

  // 2. Execute the plan
  let finalPlan = plan;
  const execution = await executePlan(finalPlan.steps, ctx);

  // 3. Wait for memory pipeline before merging (it ran in background)
  await memoryPromise;

  // 4. Merge step results into a single response
  const merged = mergeResults(execution.steps, memoryPayload);

  // 4b. Self-Reflection Loop
  //     Only runs on text replies ≥ 100 chars.
  //     Skips image-only, memory-only, short responses, AND math results
  //     (math queries are already verified by the two-model pipeline).
  const reflected = await reflectOnAnswer(userMessage, merged, merged._isMathResult);

  const finalResponse: OrchestratorResponse = {
    ...reflected.merged,
    reflection: reflected.reflection,
    confidence: 1.0,
  };

  // 5. Cache the final answer for future identical queries
  //    Only cache conversation replies (not images, charts, file analysis, or memory updates).
  if (
    finalResponse.reply &&
    finalResponse.route === "normal_chat" &&
    !hasRawFiles
  ) {
    setCachedAnswer(userMessage, finalResponse.reply);
  }

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
 *   • Query was handled by the math verification pipeline
 */
async function reflectOnAnswer(
  userMessage: string,
  merged: Omit<OrchestratorResponse, "confidence">,
  isMathResult?: boolean,
): Promise<{
  merged: Omit<OrchestratorResponse, "confidence">;
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

  // Guard: skip for math queries — already verified by two-model pipeline
  if (isMathResult) {
    console.log("[MathPipeline] reflection skipped — math query already verified by two-model pipeline");
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
        ? { ...merged, reply: result.answer }
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
