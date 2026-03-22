// SentIQGPT v3 - Mathematical Reasoning Direct Solver
//
// Single-model math pipeline for mathematical/numerical queries.
// Uses DeepSeek directly via the shared LLM adapter.

import { callLLMAdapterDetailed } from "./PromptBuilders";
import type { LLMAdapterCall } from "./PromptBuilders";

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
  };

  const result = await callLLMAdapterDetailed(call);
  return {
    answer: result.text,
    model_used: result.model_used,
    fallback: result.fallback ?? false,
  };
}
