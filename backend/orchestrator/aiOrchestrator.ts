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
//                     ├── memory_update      → Explicit memory storage
//                     └── web_search         → Web Search Router + ChatHandler
//
//   5. Self-Reflection Loop
//        └── Answer Critic (Groq) → optional Answer Improver (Gemini)
//   6. Knowledge Cache Layer
//        └── LLM answer cache (check before pipeline, store after reflection)

import { handleChat } from "../ai/ChatHandler";
import { processMessageForMemory } from "../ai/MemoryProcessor";
import { buildContext } from "../context/contextBuilder";
import { planTask } from "./planner";
import { executePlan } from "./toolExecutor";
import { evaluateAnswer } from "../reflection/answerCritic";
import { improveAnswer } from "../reflection/answerImprover";
import { getCachedAnswer, setCachedAnswer } from "../cache/cacheManager";
import type { RawMessageContext } from "../context/contextBuilder";
import type { DetectedTool } from "./toolDetector";
import { classifyQueryType, buildSearchQuery } from "./queryClassifier";
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
  /** Memory pipeline result */
  readonly memory: {
    stored: boolean;
    type?: string;
    summary?: string;
    importance?: number;
  };
  /** Web search sources (for citation display) */
  readonly searchResults?: {
    query: string;
    results: readonly { title: string; url: string; snippet: string }[];
    provider_used?: string;
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
    case "web_search":       return "normal_chat";
    case "conversation":
    default:                 return "normal_chat";
  }
}

/** Merge multi-step results into a single OrchestratorResponse. */
function mergeResults(
  steps: readonly StepResult[],
  memoryPayload: OrchestratorResponse["memory"],
): Omit<OrchestratorResponse, "confidence"> {
  let reply: string | undefined;
  let image: OrchestratorResponse["image"] | undefined;
  let searchResults: OrchestratorResponse["searchResults"] | undefined;
  let memory = memoryPayload;
  let route: DetectedTool = "normal_chat";

  const replyParts: string[] = [];

  for (const step of steps) {
    // Track the primary route from the first step
    if (step.step === 1) {
      route = planToolToRoute(step.tool);
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

    if (step.memory?.stored) {
      memory = {
        stored: true,
        type: step.memory.type,
        summary: step.memory.summary,
        importance: step.memory.importance,
      };
    }

    if (step.searchResults?.success) {
      searchResults = {
        query: step.searchResults.query,
        results: step.searchResults.results,
        provider_used: step.searchResults.provider_used,
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
    memory,
    searchResults,
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

  // 0. Check LLM answer cache (skip for requests with file/image context)
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

  // 1. Build context (async — includes conversation compression + semantic memory)
  const ctx = await buildContext({ ...(rawContext ?? {}), userMessage });

  // 2. Run planner + memory pipeline in PARALLEL
  const [plan, memoryResult] = await Promise.all([
    planTask({
      userMessage,
      hasFileContext: ctx.hasFileContext,
    }),
    processMessageForMemory({
      message: userMessage,
      recentMessages: ctx.recentMessages,
      existingMemories: ctx.memories,
    }).catch(() => ({ stored: false as const })),
  ]);

  console.log(`[ORCHESTRATOR] plan: ${plan.steps.length} step(s)`);
  console.log(`[ORCHESTRATOR] memory stored: ${memoryResult.stored}`);

  // 2b. Query classifier safety net — override planner if it missed web search
  const classification = classifyQueryType(userMessage);
  let finalPlan = plan;
  if (classification.needsWebSearch) {
    const hasWebSearchStep = plan.steps.some(s => s.tool === "web_search");
    if (!hasWebSearchStep) {
      console.log(`[ORCHESTRATOR] classifier override: forcing web_search (rule: ${classification.matchedRule})`);
      const searchQuery = buildSearchQuery(userMessage);
      finalPlan = {
        steps: [{ step: 1, tool: "web_search" as PlanTool, input: searchQuery }],
      };
    }
  }

  const memoryPayload = memoryResult.stored
    ? {
        stored: true,
        type: memoryResult.memory?.type,
        summary: memoryResult.memory?.summary,
        importance: memoryResult.memory?.importance,
      }
    : { stored: false };

  // 3. Execute the plan
  const execution = await executePlan(finalPlan.steps, ctx);

  // 4. Merge step results into a single response
  const merged = mergeResults(execution.steps, memoryPayload);

  // 5. Self-Reflection Loop
  //    Only runs on text replies ≥ 100 chars.
  //    Skips image-only, memory-only, or short responses.
  const reflected = await reflectOnAnswer(userMessage, merged);

  const finalResponse: OrchestratorResponse = {
    ...reflected.merged,
    reflection: reflected.reflection,
    confidence: 1.0,
  };

  // 6. Cache the final answer for future identical queries
  //    Only cache conversation replies (not images, file analysis, or memory updates)
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
 */
async function reflectOnAnswer(
  userMessage: string,
  merged: Omit<OrchestratorResponse, "confidence">,
): Promise<{
  merged: Omit<OrchestratorResponse, "confidence">;
  reflection?: OrchestratorResponse["reflection"];
}> {
  // Guard: skip for non-text or short replies
  if (
    !merged.reply ||
    merged.reply.length < MIN_REFLECTION_LENGTH ||
    merged.route === "image_generation"
  ) {
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
