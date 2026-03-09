// SentIQGPT v2 — Tool Executor
//
// Executes a structured plan produced by the Task Planner.
// Runs each step sequentially, routing to the correct capability:
//
//   conversation    → ChatHandler (Gemini)
//   image_generation → Image Router (FLUX/HF/Pollinations)
//   file_analysis    → ChatHandler + file context
//   memory_update    → MemoryProcessor (force-store)
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
import { routeWebSearch } from "../tools/webSearch/webSearchRouter";
import { processMessageForMemory } from "../ai/MemoryProcessor";
import type { BuiltContext } from "../context/contextBuilder";
import type { PlanStep, PlanTool } from "./planner";
import { classifyQueryType } from "./queryClassifier";
import { selectModelForPrompt } from "./modelRouter";

// ==============================
// Types
// ==============================

export interface StepResult {
  readonly step: number;
  readonly tool: PlanTool;
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
  /** Memory output (memory_update) */
  readonly memory?: {
    stored: boolean;
    type?: string;
    summary?: string;
    importance?: number;
  };
  /** Web search output (web_search) */
  readonly searchResults?: {
    success: boolean;
    query: string;
    results: readonly { title: string; url: string; snippet: string }[];
    provider_used?: string;
    error?: string;
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
  const classification = classifyQueryType(input);
  const modelOverride = selectModelForPrompt(input, classification.category);
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
  const classification = classifyQueryType(input);
  const modelOverride = selectModelForPrompt(input, classification.category);
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

async function execWebSearch(
  input: string,
  ctx: BuiltContext,
  priorContext: string,
): Promise<StepResult> {
  const modelOverride = selectModelForPrompt(input, "factual_lookup");
  const searchResult = await routeWebSearch({ query: input });

  if (!searchResult.success || searchResult.results.length === 0) {
    return {
      step: 0,
      tool: "web_search",
      searchResults: searchResult,
      reply: `I wasn't able to find web results for "${input}". ${searchResult.error ?? ""}`.trim(),
    };
  }

  // Build a context block from search results for the LLM
  const searchContext = searchResult.results
    .map((r, i) => {
      const body = (r as { body?: string }).body;
      const content = body ?? r.snippet;
      return `[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n${content}`;
    })
    .join("\n\n");

  // Pass search results to ChatHandler for synthesis
  const chatResult = await handleChat({
    userMessage:
      `The user asked: "${input}"\n\n` +
      `Here are web search results to base your answer on:\n\n${searchContext}\n\n` +
      `Provide a comprehensive answer using these sources. ` +
      `Cite sources using [Source N] notation. ` +
      `If prior context is available, incorporate it.` +
      (priorContext ? `\n\n[Previous step context]: ${priorContext}` : ""),
    recentMessages: ctx.recentMessages,
    memories: ctx.memories,
    conversationSummary: ctx.conversationSummary,
    webSearchContext: searchContext,
    modelOverride,
  });

  return {
    step: 0,
    tool: "web_search",
    reply: chatResult.reply,
    searchResults: {
      success: true,
      query: searchResult.query,
      results: searchResult.results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      })),
      provider_used: searchResult.provider_used,
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
        case "web_search":
          result = await execWebSearch(planStep.input, ctx, priorContext);
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
