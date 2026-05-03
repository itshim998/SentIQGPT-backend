// SentIQGPT v3 - Mathematical Reasoning Direct Solver
//
// Single-model math pipeline for mathematical/numerical queries.
// Uses openai-large directly via the shared LLM adapter.

import { callLLMAdapterDetailed } from "./PromptBuilders";
import type { ImageAttachment, LLMAdapterCall } from "./PromptBuilders";
import { formatMathResponse } from "./mathFormatter";

// ==============================
// Constants
// ==============================

const PRIMARY_MODEL = "openai-large";
const SOLVER_MAX_OUTPUT_TOKENS = 2600;
const GENERATION_MAX_OUTPUT_TOKENS = 2600;
const EXAMPLE_MAX_OUTPUT_TOKENS = 2200;
const INCOMPLETE_RESPONSE_FALLBACK =
  "Sorry, I couldn't complete the response. Please try again.";

const GENERATION_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(?:give|create|generate|provide|make|write|list|suggest)\b[\s\S]{0,40}\b(?:exercise(?:s)?|example(?:s)?|practice(?:\s+problems?)?|worksheet|quiz|problem\s+set)\b/i,
  /\b(?:exercise(?:s)?|example(?:s)?|practice(?:\s+problems?)?|worksheet|quiz|problem\s+set)\b[\s\S]{0,40}\b(?:please\s+)?(?:give|create|generate|provide|make|write|list|suggest)\b/i,
];
const EXAMPLE_REQUEST_PATTERNS: readonly RegExp[] = [
  /\bas an example\b/i,
  /\bfor example\b/i,
  /\bexample\b[\s\S]{0,80}\bsolve\b/i,
  /\bsolve\b[\s\S]{0,80}\bexample\b/i,
  /\b(?:show|give|create|generate|write|make)\b[\s\S]{0,40}\b(?:an?|one)\s+(?:math\s+)?example\b/i,
  /\b(?:show|give)\s+me\b[\s\S]{0,40}\b(?:math\s+)?example\b/i,
  /\b(?:an?|one)\s+(?:math\s+)?example\b[\s\S]{0,40}\band\s+\bsolve\b/i,
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

// ==============================
// Math Pipeline
// ==============================

export function classifyMathIntent(userMessage: string): "solve" | "generation" | "example" {
  if (EXAMPLE_REQUEST_PATTERNS.some((pattern) => pattern.test(userMessage))) {
    return "example";
  }

  if (GENERATION_REQUEST_PATTERNS.some((pattern) => pattern.test(userMessage))) {
    return "generation";
  }

  if (SOLVE_SECTION_PATTERNS.some((pattern) => pattern.test(userMessage))) {
    return "solve";
  }

  return "solve";
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
    return INCOMPLETE_RESPONSE_FALLBACK;
  }

  if (/[.!?\])]$/.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
}

export function salvageTruncatedResponse(text: string): string {
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

  return INCOMPLETE_RESPONSE_FALLBACK;
}

export function normalizeMathResponse(text: string): string {
  return formatMathResponse(text)
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think[^>]*>/gi, "")
    .replace(/(?:^|\n)\s*(?:#{1,6}\s*)?final answer\s*:?\s*/gi, "\n")
    .trim();
}

/**
 * Run the single-model math solving pipeline.
 *
 * Sends only the user's original prompt to openai-large with no app-added
 * system prompt or follow-up rewrite/continuation prompt.
 */
export async function solveMathDirect(
  userMessage: string,
  userId?: string,
  imageAttachments?: readonly ImageAttachment[],
): Promise<{ answer: string; thinking?: string; model_used?: string; fallback?: boolean }> {
  const intent = classifyMathIntent(userMessage);
  console.log(`[MathPipeline] intent=${intent}`);

  const call: LLMAdapterCall = {
    task: "chat",
    prompt: userMessage,
    model_override: PRIMARY_MODEL,
    user_id: userId,
    timeout_ms: 180_000,
    max_output_tokens:
      intent === "generation"
        ? GENERATION_MAX_OUTPUT_TOKENS
        : intent === "example"
          ? EXAMPLE_MAX_OUTPUT_TOKENS
          : SOLVER_MAX_OUTPUT_TOKENS,
    skip_wrappers: true,
    image_attachments: imageAttachments,
  };

  const result = await callLLMAdapterDetailed(call);
  const answer = result.text.trim() || INCOMPLETE_RESPONSE_FALLBACK;

  return {
    answer,
    thinking: undefined,
    model_used: result.model_used,
    fallback: result.fallback ?? false,
  };
}
