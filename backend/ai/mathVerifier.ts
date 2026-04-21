// SentIQGPT v3 - Mathematical Reasoning Direct Solver
//
// Single-model math pipeline for mathematical/numerical queries.
// Uses openai-large directly via the shared LLM adapter.

import { callLLMAdapterDetailed } from "./PromptBuilders";
import type { LLMAdapterCall } from "./PromptBuilders";
import { formatMathResponse } from "./mathFormatter";
import { composeUserFacingReply, extractUserFacingAnswer } from "./replyGuard";

// ==============================
// Constants
// ==============================

const PRIMARY_MODEL = "openai-large";
const SOLVER_MAX_OUTPUT_TOKENS = 2600;
const SOLVER_RETRY_MAX_OUTPUT_TOKENS = 1800;
const GENERATION_MAX_OUTPUT_TOKENS = 2600;
const GENERATION_RETRY_MAX_OUTPUT_TOKENS = 1400;
const EXAMPLE_MAX_OUTPUT_TOKENS = 2200;
const EXAMPLE_RETRY_MAX_OUTPUT_TOKENS = 1400;
const REWRITE_MAX_OUTPUT_TOKENS = 900;
const CONTINUATION_MAX_OUTPUT_TOKENS = 2000;
const MAX_CONTINUATION_ATTEMPTS = 3;
const INCOMPLETE_RESPONSE_FALLBACK =
  "Sorry, I couldn't complete the response. Please try again.";
export const DEFAULT_SOLVER_SYSTEM_PROMPT =
  "SYSTEM: You are a precise mathematical assistant for end users.\n" +
  "RULES:\n" +
  "- Provide a clear user-facing solution.\n" +
  "- Do not include chain-of-thought or hidden reasoning.\n" +
  "- If the user asks for steps, show concise steps.\n" +
  "- Format mathematics as readable LaTeX; prefer \\(...\\) for inline math and \\[...] for display math.\n" +
  "- If the problem statement looks inconsistent, say so briefly and give the best resolution.\n" +
  "- If the user asks to continue, return only the continuation of the answer.";
const GENERATION_SYSTEM_PROMPT =
  "SYSTEM: You are generating math practice content.\n" +
  "RULES:\n" +
  "- Return exactly 4 short exercise questions.\n" +
  "- Format any mathematics as readable LaTeX; prefer \\(...\\) for inline math and \\[...] for display math.\n" +
  "- Keep matrix exercises compact and readable.\n" +
  "- If you use matrices, prefer 2x2 or 3x3 examples.\n" +
  "- Finish every exercise completely.\n" +
  "- If the user asks to continue, return only the continuation of the answer.";
const GENERATION_RETRY_SYSTEM_PROMPT =
  "SYSTEM: You are generating compact math practice content.\n" +
  "RULES:\n" +
  "- Return exactly 3 short exercise questions.\n" +
  "- Format any mathematics as readable LaTeX; prefer \\(...\\) for inline math and \\[...] for display math.\n" +
  "- Keep each exercise on one line.\n" +
  "- Use plain concise wording.\n" +
  "- If you use matrices, keep them small and complete.\n" +
  "- Finish the response fully.\n" +
  "- If the user asks to continue, return only the continuation of the answer.";
const EXAMPLE_SYSTEM_PROMPT =
  "SYSTEM: Create one relevant math example for the user's topic and solve it clearly.\n" +
  "RULES:\n" +
  "- If the user gives a topic instead of a concrete problem, choose one representative example.\n" +
  "- Provide the example and its solution.\n" +
  "- If the user asks for steps, show concise steps.\n" +
  "- Keep the answer concise and user-facing.\n" +
  "- Format mathematics as readable LaTeX; prefer \\(...\\) for inline math and \\[...] for display math.\n" +
  "- Do not include chain-of-thought or hidden reasoning.\n" +
  "- If the user asks to continue, return only the continuation of the answer.";
const EXAMPLE_RETRY_SYSTEM_PROMPT =
  "SYSTEM: Provide one short solved math example for the user.\n" +
  "RULES:\n" +
  "- Keep the example and solution concise.\n" +
  "- If the user asks for steps, show concise steps.\n" +
  "- Format mathematics as readable LaTeX; prefer \\(...\\) for inline math and \\[...] for display math.\n" +
  "- Do not include chain-of-thought or hidden reasoning.\n" +
  "- If the user asks to continue, return only the continuation of the answer.";
const COMPACT_SOLVER_SYSTEM_PROMPT =
  "SYSTEM: Give a concise user-facing math solution.\n" +
  "RULES:\n" +
  "- Provide a clear answer; include key method details when useful.\n" +
  "- If the user asks for steps, show concise steps.\n" +
  "- Format mathematics as readable LaTeX; prefer \\(...\\) for inline math and \\[...] for display math.\n" +
  "- Do not include chain-of-thought or hidden reasoning.\n" +
  "- If the user asks to continue, return only the continuation of the answer.";
const REWRITE_SYSTEM_PROMPT =
  "SYSTEM: Rewrite the draft math answer for the end user.\n" +
  "RULES:\n" +
  "- Keep the mathematics unchanged.\n" +
  "- Remove narration, meta wording, and prompt echo.\n" +
  "- Keep a concise user-facing answer; include steps only if the user asked for them.\n" +
  "- Normalize mathematics into readable LaTeX; prefer \\(...\\) for inline math and \\[...] for display math.\n" +
  "- Preserve essential intermediate equations, matrices, substitutions, or elimination steps.\n" +
  "- Do not include chain-of-thought or hidden reasoning.\n" +
  "- Return only the rewritten answer.\n" +
  "- If the user asks to continue, return only the continuation of the answer.";
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

function buildMathPrompt(
  userMessage: string,
  systemPrompt: string,
  intent: "solve" | "generation" | "example",
  retryMode: "none" | "compact-solve" | "compact-generation" = "none",
): string {
  const effectiveSystemPrompt =
    intent === "generation"
      ? (retryMode === "compact-generation" ? GENERATION_RETRY_SYSTEM_PROMPT : GENERATION_SYSTEM_PROMPT)
      : intent === "example"
        ? (retryMode === "compact-generation" ? EXAMPLE_RETRY_SYSTEM_PROMPT : EXAMPLE_SYSTEM_PROMPT)
      : (retryMode === "compact-solve" ? COMPACT_SOLVER_SYSTEM_PROMPT : systemPrompt);

  return effectiveSystemPrompt
    ? `${effectiveSystemPrompt}\n\nUser: ${userMessage}`
    : userMessage;
}

function buildContinuationPrompt(
  userMessage: string,
  systemPrompt: string,
  answerSoFar: string,
): string {
  return [
    systemPrompt,
    "",
    "User: The previous answer was cut off. Continue the answer only.",
    "Do not repeat any earlier text. Do not include chain-of-thought or a <think> block.",
    "",
    "Original problem:",
    userMessage,
    "",
    "Answer so far:",
    answerSoFar,
  ].join("\n");
}

function cleanContinuationText(text: string): string {
  return text
    .replace(/^(?:final answer|answer)\s*[:\-]\s*/i, "")
    .replace(/<\/?.*?think[^>]*>/gi, "")
    .trim();
}

function mergeContinuation(base: string, continuation: string): string {
  const left = base.trimEnd();
  const right = cleanContinuationText(continuation);
  if (!right) return left;

  const maxOverlap = Math.min(400, left.length, right.length);
  let overlap = 0;
  for (let size = maxOverlap; size >= 20; size -= 1) {
    if (left.endsWith(right.slice(0, size))) {
      overlap = size;
      break;
    }
  }

  const glue = left.endsWith("\n") || right.startsWith("\n") ? "" : "\n";
  const merged = `${left}${glue}${right.slice(overlap)}`.trim();
  return merged || left;
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

function extractMathCandidate(text: string, adapterError?: string | null): string {
  const extracted = extractUserFacingAnswer(text, { adapterError });
  return composeUserFacingReply(extracted, { preferExplanation: true }) ?? "";
}

function extractMathContinuationCandidate(text: string, adapterError?: string | null): string {
  const extracted = extractUserFacingAnswer(text, { adapterError });
  return extracted.reply?.trim() ?? "";
}

function extractMathThinking(text: string, adapterError?: string | null): string | undefined {
  const extracted = extractUserFacingAnswer(text, { adapterError });
  const thinking = extracted.thinking?.trim();
  return thinking ? thinking : undefined;
}

function buildRewritePrompt(userMessage: string, draftAnswer: string): string {
  return [
    REWRITE_SYSTEM_PROMPT,
    "",
    "Original problem:",
    userMessage,
    "",
    "Draft answer to rewrite:",
    draftAnswer,
  ].join("\n");
}

async function rewriteMathAnswer(
  userMessage: string,
  draftAnswer: string,
  userId?: string,
): Promise<string> {
  const rewriteCall: LLMAdapterCall = {
    task: "chat",
    prompt: buildRewritePrompt(userMessage, draftAnswer),
    model_override: PRIMARY_MODEL,
    user_id: userId,
    timeout_ms: 120_000,
    max_output_tokens: REWRITE_MAX_OUTPUT_TOKENS,
    skip_wrappers: true,
  };

  const rewriteResult = await callLLMAdapterDetailed(rewriteCall);
  return normalizeMathResponse(extractMathCandidate(rewriteResult.text, rewriteResult.error));
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
): Promise<{ answer: string; thinking?: string; model_used?: string; fallback?: boolean }> {
  const intent = classifyMathIntent(userMessage);
  console.log(`[MathPipeline] intent=${intent}`);

  const makeCall = async (retryMode: "none" | "compact-solve" | "compact-generation" = "none") => {
    const call: LLMAdapterCall = {
      task: "chat",
      prompt: buildMathPrompt(userMessage, systemPrompt, intent, retryMode),
      model_override: PRIMARY_MODEL,
      user_id: userId,
      timeout_ms: 180_000,
      max_output_tokens:
        intent === "generation"
          ? (retryMode === "compact-generation" ? GENERATION_RETRY_MAX_OUTPUT_TOKENS : GENERATION_MAX_OUTPUT_TOKENS)
          : intent === "example"
            ? (retryMode === "compact-generation" ? EXAMPLE_RETRY_MAX_OUTPUT_TOKENS : EXAMPLE_MAX_OUTPUT_TOKENS)
          : (retryMode === "compact-solve" ? SOLVER_RETRY_MAX_OUTPUT_TOKENS : SOLVER_MAX_OUTPUT_TOKENS),
      skip_wrappers: true,
    };

    return callLLMAdapterDetailed(call);
  };

  const makeContinuationCall = async (answerSoFar: string) => {
    const call: LLMAdapterCall = {
      task: "chat",
      prompt: buildContinuationPrompt(userMessage, systemPrompt, answerSoFar),
      model_override: PRIMARY_MODEL,
      user_id: userId,
      timeout_ms: 160_000,
      max_output_tokens: CONTINUATION_MAX_OUTPUT_TOKENS,
      skip_wrappers: true,
    };
    return callLLMAdapterDetailed(call);
  };

  let result = await makeCall("none");
  let thinking = extractMathThinking(result.text, result.error);
  let processed = normalizeMathResponse(extractMathCandidate(result.text, result.error));
  let incompleteOutput =
    result.truncated || hasIncompleteMathTail(processed) || hasIncompleteProseTail(processed);

  if (incompleteOutput) {
    console.log(`[MathPipeline] continuation_loop start truncated=${result.truncated ? "true" : "false"}`);
    for (let attempt = 0; attempt < MAX_CONTINUATION_ATTEMPTS && incompleteOutput; attempt += 1) {
      if (!processed || processed.trim().length < 20) {
        break;
      }

      const continuationResult = await makeContinuationCall(processed);
      const continuationText = normalizeMathResponse(
        extractMathContinuationCandidate(continuationResult.text, continuationResult.error),
      );
      if (!continuationText) {
        break;
      }

      const merged = mergeContinuation(processed, continuationText);
      if (merged === processed) {
        break;
      }

      processed = merged;
      incompleteOutput =
        continuationResult.truncated || hasIncompleteMathTail(processed) || hasIncompleteProseTail(processed);
    }
  }

  if (incompleteOutput) {
    console.log(
      `[MathPipeline] salvaging incomplete output finish_reason=${result.finish_reason ?? "unknown"} truncated=${result.truncated ? "true" : "false"} chars=${processed.length}`,
    );
    processed = salvageTruncatedResponse(processed);
    thinking = undefined;
  }

  return {
    answer: processed,
    thinking,
    model_used: result.model_used,
    fallback: result.fallback ?? false,
  };
}
