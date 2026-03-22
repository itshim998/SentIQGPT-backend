// SentIQGPT v3 - Mathematical Reasoning Direct Solver
//
// Single-model math pipeline for mathematical/numerical queries.
// Uses DeepSeek directly via the shared LLM adapter.

import { callLLMAdapterDetailed } from "./PromptBuilders";
import type { LLMAdapterCall } from "./PromptBuilders";
import { formatMathResponse } from "./mathFormatter";
import { shapeMathResponse } from "./responseShaper";

// ==============================
// Constants
// ==============================

const PRIMARY_MODEL = "deepseek";

// ==============================
// Math Pipeline
// ==============================

/**
 * Run the single-model math solving pipeline.
 *
 * @param userMessage - The original user query
 * @param systemPrompt - The system prompt context (from the orchestrator)
 * @returns The math answer
 */
export async function solveMathDirect(
  userMessage: string,
  systemPrompt: string,
): Promise<{ answer: string; model_used?: string; fallback?: boolean }> {
  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\nUser: ${userMessage}`
    : userMessage;

  const call: LLMAdapterCall = {
    task: "chat",
    prompt: fullPrompt,
    model_override: PRIMARY_MODEL,
    timeout_ms: 115_000,
  };

  const result = await callLLMAdapterDetailed(call);
  let processed = formatMathResponse(result.text);
  processed = shapeMathResponse(processed);

  if (/i will|let's solve|we are given/i.test(processed)) {
    processed = processed.replace(/i will|let's solve|we are given/gi, "");
  }

  return {
    answer: processed,
    model_used: result.model_used,
    fallback: result.fallback ?? false,
  };
}
