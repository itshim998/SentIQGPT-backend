// SentIQGPT v3 - Mathematical Reasoning Direct Solver
//
// Single-model math pipeline for mathematical/numerical queries.
// Uses openai-large directly via the shared LLM adapter.

import { buildChatPrompt, callLLMAdapterDetailed } from "./PromptBuilders";
import type { ImageAttachment } from "./PromptBuilders";
import { isProviderFailurePayload } from "./replyGuard";

// ==============================
// Constants
// ==============================

const PRIMARY_MODEL = "openai-large";
const SOLVER_MAX_OUTPUT_TOKENS = 6000;
const GENERATION_MAX_OUTPUT_TOKENS = 6000;
const EXAMPLE_MAX_OUTPUT_TOKENS = 6000;
const CONTINUATION_MAX_OUTPUT_TOKENS = 3000;
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

function normalizeRawMathAnswer(text: string, fallback = INCOMPLETE_RESPONSE_FALLBACK): string {
  const raw = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw || isProviderFailurePayload(raw)) {
    return fallback;
  }
  return raw;
}

function shouldRequestContinuation(result: {
  readonly finish_reason?: string | null;
  readonly truncated?: boolean;
}): boolean {
  const reason = (result.finish_reason ?? "").trim().toLowerCase();
  return Boolean(result.truncated) || reason === "length" || reason === "max_tokens";
}

function mergeRawContinuation(base: string, continuation: string): string {
  const left = base.trimEnd();
  const right = continuation.trim();
  if (!right) return left;

  const maxOverlap = Math.min(300, left.length, right.length);
  let overlap = 0;
  for (let size = maxOverlap; size >= 20; size -= 1) {
    if (left.endsWith(right.slice(0, size))) {
      overlap = size;
      break;
    }
  }

  const glue = left.endsWith("\n") || right.startsWith("\n") ? "" : "\n";
  return `${left}${glue}${right.slice(overlap)}`.trim();
}

function buildMathContinuationMessage(userMessage: string, answerSoFar: string): string {
  return [
    "Continue the math answer only.",
    "Do not repeat any earlier text. Do not include hidden chain-of-thought or a <think> block.",
    "Keep using clean Markdown with renderer-safe LaTeX delimiters: \\( ... \\) and \\[ ... \\].",
    "",
    "Original question:",
    userMessage,
    "",
    "Answer so far:",
    answerSoFar,
  ].join("\n");
}

function getMaxOutputTokensForIntent(intent: ReturnType<typeof classifyMathIntent>): number {
  if (intent === "generation") return GENERATION_MAX_OUTPUT_TOKENS;
  if (intent === "example") return EXAMPLE_MAX_OUTPUT_TOKENS;
  return SOLVER_MAX_OUTPUT_TOKENS;
}

export async function callMathModelRaw(args: {
  readonly userMessage: string;
  readonly modelOverride: string;
  readonly userId?: string;
  readonly recentMessages?: readonly { role: string; content: string }[];
  readonly memories?: readonly { type: string; summary: string }[];
  readonly fileReferences?: readonly { filename: string; extractedText: string }[];
  readonly imageAttachments?: readonly ImageAttachment[];
  readonly conversationSummary?: string;
  readonly priorConversationEvidence?: readonly { content: string; createdAt?: string }[];
  readonly isExplicitRecallQuery?: boolean;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly emptyFallback?: string;
}): Promise<{ answer: string; thinking?: string; model_used?: string; fallback?: boolean }> {
  const call = buildChatPrompt({
    userMessage: args.userMessage,
    recentMessages: args.recentMessages,
    memories: args.memories,
    fileReferences: args.fileReferences,
    imageAttachments: args.imageAttachments,
    conversationSummary: args.conversationSummary,
    priorConversationEvidence: args.priorConversationEvidence,
    isExplicitRecallQuery: args.isExplicitRecallQuery,
    modelOverride: args.modelOverride,
    userId: args.userId,
    mathMode: true,
  });

  const result = await callLLMAdapterDetailed({
    ...call,
    max_output_tokens: args.maxOutputTokens ?? SOLVER_MAX_OUTPUT_TOKENS,
    timeout_ms: args.timeoutMs ?? 180_000,
    skip_wrappers: true,
  });

  const fallbackText = args.emptyFallback ?? INCOMPLETE_RESPONSE_FALLBACK;
  let answer = normalizeRawMathAnswer(result.text, fallbackText);
  let fallback = result.fallback ?? false;

  if (answer !== fallbackText && shouldRequestContinuation(result)) {
    try {
      const continuationCall = buildChatPrompt({
        userMessage: buildMathContinuationMessage(args.userMessage, answer),
        recentMessages: [],
        memories: [],
        fileReferences: args.fileReferences,
        imageAttachments: args.imageAttachments,
        conversationSummary: args.conversationSummary,
        priorConversationEvidence: args.priorConversationEvidence,
        isExplicitRecallQuery: args.isExplicitRecallQuery,
        modelOverride: args.modelOverride,
        userId: args.userId,
        mathMode: true,
      });
      const continuationResult = await callLLMAdapterDetailed({
        ...continuationCall,
        max_output_tokens: CONTINUATION_MAX_OUTPUT_TOKENS,
        timeout_ms: args.timeoutMs ?? 180_000,
        skip_wrappers: true,
      });
      const continuation = normalizeRawMathAnswer(continuationResult.text, "");
      if (continuation) {
        answer = mergeRawContinuation(answer, continuation);
      }
      fallback = fallback || (continuationResult.fallback ?? false);
    } catch {
      // Keep the raw first pass if continuation fails.
    }
  }

  return {
    answer,
    thinking: undefined,
    model_used: result.model_used,
    fallback,
  };
}

/**
 * Run the single-model math solving pipeline.
 *
 * Sends the user prompt through the math system prompt and returns the raw
 * provider text. Formatting is prompt-governed only.
 */
export async function solveMathDirect(
  userMessage: string,
  userId?: string,
  imageAttachments?: readonly ImageAttachment[],
): Promise<{ answer: string; thinking?: string; model_used?: string; fallback?: boolean }> {
  const intent = classifyMathIntent(userMessage);
  console.log(`[MathPipeline] intent=${intent}`);

  return callMathModelRaw({
    userMessage,
    modelOverride: PRIMARY_MODEL,
    userId,
    imageAttachments,
    maxOutputTokens: getMaxOutputTokensForIntent(intent),
  });
}
