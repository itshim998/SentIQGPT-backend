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
const SOLVER_MAX_OUTPUT_TOKENS = 1600;
const GENERATION_MAX_OUTPUT_TOKENS = 2600;
const GENERATION_RETRY_MAX_OUTPUT_TOKENS = 1400;
const GENERATION_SYSTEM_PROMPT =
  "SYSTEM: You are generating math practice content.\n" +
  "RULES:\n" +
  "- Respond concisely and completely\n" +
  "- Do NOT use long preambles or teaching paragraphs\n" +
  "- Do NOT include meta commentary\n" +
  "- Return exactly 4 short exercise questions\n" +
  "- Keep matrix exercises compact and readable\n" +
  "- If you use matrices, prefer 2x2 or 3x3 examples\n" +
  "- Finish every exercise completely";
const GENERATION_RETRY_SYSTEM_PROMPT =
  "SYSTEM: You are generating compact math practice content.\n" +
  "RULES:\n" +
  "- Return exactly 3 short exercise questions\n" +
  "- No explanations, no preamble, no commentary\n" +
  "- Keep each exercise on one line\n" +
  "- Use plain concise wording\n" +
  "- If you use matrices, keep them small and complete\n" +
  "- Finish the response fully";
const GENERATION_PATTERNS: readonly RegExp[] = [
  /\bexercise(?:s)?\b/i,
  /\bpractice\b/i,
  /\bexample(?:s)?\b/i,
  /\bworksheet\b/i,
  /\bquiz\b/i,
  /\bquestion(?:s)?\b/i,
  /\bgenerate\b/i,
  /\bcreate\b/i,
  /\bgive\b.*\b(?:exercise|question|example|problem)s?\b/i,
];

// ==============================
// Math Pipeline
// ==============================

function isGenerationMathRequest(userMessage: string): boolean {
  return GENERATION_PATTERNS.some((pattern) => pattern.test(userMessage));
}

function buildMathPrompt(
  userMessage: string,
  systemPrompt: string,
  generationMode: boolean,
  retryCompact = false,
): string {
  const effectiveSystemPrompt = generationMode
    ? (retryCompact ? GENERATION_RETRY_SYSTEM_PROMPT : GENERATION_SYSTEM_PROMPT)
    : systemPrompt;

  return effectiveSystemPrompt
    ? `${effectiveSystemPrompt}\n\nUser: ${userMessage}`
    : userMessage;
}

function findIncompleteMathStart(text: string): number | null {
  const tokenPattern = /\\\(|\\\)|\\\[|\\\]|\\begin\{([^}]+)\}|\\end\{([^}]+)\}/g;
  const stack: Array<{ type: "inline" | "display" | "env"; index: number; name?: string }> = [];

  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;

    if (token === "\\(") {
      stack.push({ type: "inline", index });
      continue;
    }
    if (token === "\\[") {
      stack.push({ type: "display", index });
      continue;
    }
    if (token.startsWith("\\begin{")) {
      stack.push({ type: "env", index, name: match[1] });
      continue;
    }
    if (token === "\\)") {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].type === "inline") {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }
    if (token === "\\]") {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].type === "display") {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }
    if (token.startsWith("\\end{")) {
      const envName = match[2];
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].type === "env" && stack[i].name === envName) {
          stack.splice(i, 1);
          break;
        }
      }
    }
  }

  if (stack.length > 0) {
    return stack[stack.length - 1].index;
  }

  const danglingMatch = text.match(/(?:\\\(|\\\[|\\begin\{[^}]+\})\s*$/);
  if (danglingMatch && danglingMatch.index !== undefined) {
    return danglingMatch.index;
  }

  return null;
}

function hasIncompleteMathTail(text: string): boolean {
  return findIncompleteMathStart(text) !== null;
}

function degradeIncompleteMathTail(text: string): string {
  const start = findIncompleteMathStart(text);
  if (start === null) return text;

  const prefix = text.slice(0, start).trimEnd();
  if (!prefix) {
    return "The response was truncated before the math content completed.";
  }
  return `${prefix} [incomplete math omitted]`;
}

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
  const generationMode = isGenerationMathRequest(userMessage);
  const makeCall = async (retryCompact = false) => {
    const call: LLMAdapterCall = {
      task: "chat",
      prompt: buildMathPrompt(userMessage, systemPrompt, generationMode, retryCompact),
      model_override: PRIMARY_MODEL,
      timeout_ms: 115_000,
      max_output_tokens: generationMode
        ? (retryCompact ? GENERATION_RETRY_MAX_OUTPUT_TOKENS : GENERATION_MAX_OUTPUT_TOKENS)
        : SOLVER_MAX_OUTPUT_TOKENS,
    };

    return callLLMAdapterDetailed(call);
  };

  let result = await makeCall(false);
  let processed = shapeMathResponse(formatMathResponse(result.text));

  if (/i will|let's solve|we are given/i.test(processed)) {
    processed = processed.replace(/i will|let's solve|we are given/gi, "");
  }

  const needsRetry = generationMode && (result.truncated || hasIncompleteMathTail(processed));
  if (needsRetry) {
    console.log("[MathPipeline] compact retry triggered for incomplete or truncated generation output");
    if (result.finish_reason) {
      console.log(`[MathPipeline] provider finish_reason=${result.finish_reason}`);
    }
    result = await makeCall(true);
    processed = shapeMathResponse(formatMathResponse(result.text));
    if (/i will|let's solve|we are given/i.test(processed)) {
      processed = processed.replace(/i will|let's solve|we are given/gi, "");
    }
  }

  if (hasIncompleteMathTail(processed)) {
    console.log("[MathPipeline] incomplete math tail detected; degrading broken fragment");
    processed = degradeIncompleteMathTail(processed);
  }

  return {
    answer: processed,
    model_used: result.model_used,
    fallback: result.fallback ?? false,
  };
}
