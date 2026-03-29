// SentIQGPT v3 - Mathematical Reasoning Direct Solver
//
// Single-model math pipeline for mathematical/numerical queries.
// Uses MiniMax directly via the shared LLM adapter.

import { callLLMAdapterDetailed } from "./PromptBuilders";
import type { LLMAdapterCall } from "./PromptBuilders";
import { formatMathResponse } from "./mathFormatter";
import { hasMathLeakageSignals, shapeMathResponse } from "./responseShaper";

// ==============================
// Constants
// ==============================

const PRIMARY_MODEL = "minimax";
const SOLVER_MAX_OUTPUT_TOKENS = 2600;
const SOLVER_RETRY_MAX_OUTPUT_TOKENS = 1800;
const GENERATION_MAX_OUTPUT_TOKENS = 2600;
const GENERATION_RETRY_MAX_OUTPUT_TOKENS = 1400;
const TRUNCATION_NOTICE =
  "The mathematical response was truncated before completion. Please ask for a shorter or more focused solution.";
export const DEFAULT_SOLVER_SYSTEM_PROMPT =
  "SYSTEM: You are SentIQGPT's math reasoning solver.\n" +
  "VISIBLE ANSWER CONTRACT:\n" +
  "- Produce a polished user-facing answer, not hidden chain-of-thought.\n" +
  "- Do NOT reveal internal scratchwork, retries, or self-corrections.\n" +
  "- Do NOT say phrases like 'let me solve', 'wait', 'let me reconsider', 'let me verify', or 'something is off'.\n" +
  "- Do NOT narrate failed attempts.\n" +
  "- Keep the explanation concise, decisive, and readable.\n" +
  "RESPONSE FORMAT:\n" +
  "### Key Insight\n" +
  "- One short bullet with the core idea.\n" +
  "### Solution\n" +
  "- Two to five short bullets with only the essential reasoning or equations.\n" +
  "### Final Answer\n" +
  "- One direct conclusion.\n" +
  "STYLE RULES:\n" +
  "- Use markdown headings and bullets.\n" +
  "- Use equations only when they genuinely help.\n" +
  "- If the problem statement appears inconsistent, state that briefly and give the best resolution.\n" +
  "- No repetition. No meta commentary. No long scratchwork paragraphs.";
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
const COMPACT_SOLVER_SYSTEM_PROMPT =
  "SYSTEM: You are SentIQGPT's compact math reasoning solver.\n" +
  "OUTPUT FORMAT:\n" +
  "### Key Insight\n" +
  "- One short bullet.\n" +
  "### Solution\n" +
  "- Two to four short bullets.\n" +
  "### Final Answer\n" +
  "- One direct line.\n" +
  "RULES:\n" +
  "- No chain-of-thought, no self-talk, and no restating the whole problem.\n" +
  "- Include only decisive equations or comparisons.\n" +
  "- No repetition, no failed attempts, no meta commentary.";
const GENERATION_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(?:give|create|generate|provide|make|write|list|suggest)\b[\s\S]{0,40}\b(?:exercise(?:s)?|example(?:s)?|practice(?:\s+problems?)?|worksheet|quiz|problem\s+set)\b/i,
  /\b(?:exercise(?:s)?|example(?:s)?|practice(?:\s+problems?)?|worksheet|quiz|problem\s+set)\b[\s\S]{0,40}\b(?:please\s+)?(?:give|create|generate|provide|make|write|list|suggest)\b/i,
];
const SOLVE_SECTION_PATTERNS: readonly RegExp[] = [
  /\bquestions?\s*:/i,
  /\bdetermine\s*:/i,
  /\bstate\s+whether\s*:/i,
  /\bobjective\s*:/i,
  /\bconstraints?\s*:/i,
  /\bformulate\b/i,
  /\bminimi[sz]e\b/i,
  /\bmaximi[sz]e\b/i,
  /\bsubject\s+to\b/i,
];
const META_REASONING_PATTERN = /i will|let's solve|we are given/gi;

// ==============================
// Math Pipeline
// ==============================

function classifyMathIntent(userMessage: string): "solve" | "generation" {
  if (SOLVE_SECTION_PATTERNS.some((pattern) => pattern.test(userMessage))) {
    return "solve";
  }

  if (GENERATION_REQUEST_PATTERNS.some((pattern) => pattern.test(userMessage))) {
    return "generation";
  }

  return "solve";
}

function buildMathPrompt(
  userMessage: string,
  systemPrompt: string,
  intent: "solve" | "generation",
  retryMode: "none" | "compact-solve" | "compact-generation" = "none",
): string {
  const effectiveSystemPrompt =
    intent === "generation"
      ? (retryMode === "compact-generation" ? GENERATION_RETRY_SYSTEM_PROMPT : GENERATION_SYSTEM_PROMPT)
      : (retryMode === "compact-solve" ? COMPACT_SOLVER_SYSTEM_PROMPT : systemPrompt);

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

function hasIncompleteProseTail(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  if (/[=:]\s*$/.test(trimmed)) {
    return true;
  }

  if (/\b(?:Determine|State whether|Questions?|Objective|Constraints?)\s*:?\s*$/i.test(trimmed)) {
    return true;
  }

  if (/(?:^|\n)\s*\d+\.\s+[^\n]*[:=]\s*$/m.test(trimmed)) {
    return true;
  }

  if (/(?:^|\n)\s*\d+\.\s*$/m.test(trimmed)) {
    return true;
  }

  return false;
}

function trimToLastCompleteBoundary(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const sentenceMatches = [...trimmed.matchAll(/[.!?](?=\s|$)/g)];
  if (sentenceMatches.length > 0) {
    const lastMatch = sentenceMatches[sentenceMatches.length - 1];
    return trimmed.slice(0, (lastMatch.index ?? 0) + 1).trim();
  }

  const numberedSteps = [...trimmed.matchAll(/(?:^|\n)\s*\d+\.\s/g)];
  if (numberedSteps.length > 1) {
    const lastStep = numberedSteps[numberedSteps.length - 1];
    return trimmed.slice(0, lastStep.index ?? 0).trim();
  }

  const lastLineBreak = trimmed.lastIndexOf("\n");
  if (lastLineBreak > 0) {
    return trimmed.slice(0, lastLineBreak).trim();
  }

  return "";
}

function finalizeSalvagedText(text: string): string {
  const trimmed = text
    .trim()
    .replace(/(?:^|\n)\s*\d+\.\s*$/m, "")
    .replace(/[=:]\s*$/, "")
    .trim();
  if (!trimmed) {
    return TRUNCATION_NOTICE;
  }

  if (/[.!?\])]$/.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
}

function salvageTruncatedResponse(text: string): string {
  let candidate = hasIncompleteMathTail(text) ? degradeIncompleteMathTail(text) : text;
  candidate = candidate
    .replace(/(?:^|\n)\s*\d+\.\s*$/m, "")
    .replace(/\b(?:Determine|State whether|Questions?|Objective|Constraints?)\s*:?\s*$/i, "")
    .replace(/[=:]\s*$/, "")
    .trim();

  if (candidate && !hasIncompleteMathTail(candidate) && !hasIncompleteProseTail(candidate)) {
    return finalizeSalvagedText(candidate);
  }

  const bounded = trimToLastCompleteBoundary(candidate);
  if (bounded) {
    return finalizeSalvagedText(bounded);
  }

  return TRUNCATION_NOTICE;
}

export function normalizeMathResponse(text: string): string {
  return shapeMathResponse(formatMathResponse(text)).replace(META_REASONING_PATTERN, "").trim();
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
  userId?: string,
): Promise<{ answer: string; model_used?: string; fallback?: boolean }> {
  const intent = classifyMathIntent(userMessage);
  console.log(`[MathPipeline] intent=${intent}`);

  const makeCall = async (retryMode: "none" | "compact-solve" | "compact-generation" = "none") => {
    const call: LLMAdapterCall = {
      task: "chat",
      prompt: buildMathPrompt(userMessage, systemPrompt, intent, retryMode),
      model_override: PRIMARY_MODEL,
      user_id: userId,
      timeout_ms: 115_000,
      max_output_tokens:
        intent === "generation"
          ? (retryMode === "compact-generation" ? GENERATION_RETRY_MAX_OUTPUT_TOKENS : GENERATION_MAX_OUTPUT_TOKENS)
          : (retryMode === "compact-solve" ? SOLVER_RETRY_MAX_OUTPUT_TOKENS : SOLVER_MAX_OUTPUT_TOKENS),
    };

    return callLLMAdapterDetailed(call);
  };

  let result = await makeCall("none");
  let processed = normalizeMathResponse(result.text);
  let incompleteOutput =
    result.truncated || hasIncompleteMathTail(processed) || hasIncompleteProseTail(processed);
  const hasLeakage = hasMathLeakageSignals(result.text) || processed.split("\n").length > 12;

  const needsRetry = incompleteOutput || hasLeakage;
  if (needsRetry) {
    const retryMode = intent === "generation" ? "compact-generation" : "compact-solve";
    console.log(`[MathPipeline] compact retry triggered for incomplete or truncated ${intent} output`);
    if (result.finish_reason) {
      console.log(`[MathPipeline] provider finish_reason=${result.finish_reason}`);
    }
    if (hasLeakage) {
      console.log("[MathPipeline] retry_trigger=leakage_or_excessive_structure");
    }
    console.log(`[MathPipeline] retry_strategy=${retryMode}`);
    result = await makeCall(retryMode);
    processed = normalizeMathResponse(result.text);
    incompleteOutput =
      result.truncated || hasIncompleteMathTail(processed) || hasIncompleteProseTail(processed);
  }

  if (incompleteOutput) {
    console.log(
      `[MathPipeline] salvaging truncated output finish_reason=${result.finish_reason ?? "unknown"} truncated=${result.truncated ? "true" : "false"} chars=${processed.length}`,
    );
    processed = salvageTruncatedResponse(processed);
  }

  return {
    answer: processed,
    model_used: result.model_used,
    fallback: result.fallback ?? false,
  };
}
