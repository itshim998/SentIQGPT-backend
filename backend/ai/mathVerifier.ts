// SentIQGPT v3 — Mathematical Reasoning Verification System
//
// Two-model verification pipeline for mathematical/numerical queries:
//
//   Step 1: Primary solve with deepseek (via Pollinations)
//   Step 2: Verification pass with the main chat model (gemini-fast)
//   Step 3: Compare results — if they differ, run a reconciliation prompt
//
// This module is called by the orchestrator (non-streaming) and by the
// streaming endpoint (which redirects math queries through the orchestrator).
// It does NOT interfere with non-math queries or the planner tool system.

import { callLLMAdapter } from "./PromptBuilders";
import type { LLMAdapterCall } from "./PromptBuilders";

// ==============================
// Types
// ==============================

export interface MathVerificationResult {
  /** The final verified answer text */
  readonly answer: string;
  /** Whether verification was performed */
  readonly verified: boolean;
  /** Whether the two models agreed */
  readonly agreed: boolean;
  /** Whether reconciliation was needed */
  readonly reconciled: boolean;
  /** Model used for primary solve */
  readonly primaryModel: string;
  /** Model used for verification */
  readonly verifierModel: string;
}

// ==============================
// Constants
// ==============================

const PRIMARY_MODEL = "deepseek";
const VERIFIER_MODEL = "gemini-fast";

/** When false (default), only DeepSeek solves — no Gemini verification pass. */
const VERIFICATION_ENABLED =
  (process.env.ENABLE_MATH_VERIFICATION ?? "").toLowerCase() === "true";

// Short answers (< this length) are more likely to be numeric and benefit
// most from exact-match comparison. Long answers use semantic comparison.
const SHORT_ANSWER_THRESHOLD = 200;

// ==============================
// Helpers
// ==============================

/**
 * Extract the core numerical/mathematical answer from a response.
 * Strips formatting, units, and explanation to isolate the result value.
 */
function extractCoreAnswer(response: string): string {
  // Look for patterns like "= 42", "the answer is 42", "result: 42"
  const patterns = [
    /(?:=\s*)([+-]?\d[\d,]*\.?\d*(?:\s*[×x*\/+\-^]\s*\d[\d,]*\.?\d*)*)/,
    /(?:answer\s+is\s*:?\s*)([+-]?\d[\d,]*\.?\d*)/i,
    /(?:result\s*:?\s*)([+-]?\d[\d,]*\.?\d*)/i,
    /(?:equals?\s+)([+-]?\d[\d,]*\.?\d*)/i,
    /∴\s*([+-]?\d[\d,]*\.?\d*)/,
    /(?:therefore\s*,?\s*)([+-]?\d[\d,]*\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/,/g, "").trim();
    }
  }

  // Fallback: return a normalized version for semantic comparison
  return response
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

/**
 * Compare two math answers.
 * Returns true if they are essentially equivalent.
 */
function answersMatch(primary: string, verifier: string): boolean {
  const coreA = extractCoreAnswer(primary);
  const coreB = extractCoreAnswer(verifier);

  // Exact numeric match
  if (coreA === coreB) return true;

  // Try parsing as numbers for fuzzy numeric comparison
  const numA = parseFloat(coreA);
  const numB = parseFloat(coreB);
  if (!isNaN(numA) && !isNaN(numB)) {
    // Allow tiny floating-point difference
    const diff = Math.abs(numA - numB);
    const tolerance = Math.max(Math.abs(numA), Math.abs(numB)) * 1e-6;
    if (diff <= Math.max(tolerance, 1e-10)) return true;
  }

  // For longer answers, check if the core content has high overlap
  if (primary.length > SHORT_ANSWER_THRESHOLD) {
    // Normalized substring check — if one contains the other's core answer
    const normA = primary.toLowerCase().replace(/\s+/g, " ");
    const normB = verifier.toLowerCase().replace(/\s+/g, " ");
    if (normA.includes(coreB) || normB.includes(coreA)) return true;
  }

  return false;
}

// ==============================
// Verification Pipeline
// ==============================

/**
 * Run the two-model math verification pipeline.
 *
 * @param userMessage - The original user query
 * @param systemPrompt - The system prompt context (from the orchestrator)
 * @returns The verified math answer
 */
export async function verifyMathAnswer(
  userMessage: string,
  systemPrompt: string,
): Promise<MathVerificationResult> {
  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\nUser: ${userMessage}`
    : userMessage;

  // ── Step 1: Primary solve with deepseek ──
  console.log(`[MathPipeline] solving with ${PRIMARY_MODEL}`);
  const primaryCall: LLMAdapterCall = {
    task: "chat",
    prompt: fullPrompt,
    model_override: PRIMARY_MODEL,
  };

  let primaryAnswer: string;
  try {
    primaryAnswer = await callLLMAdapter(primaryCall);
  } catch (err) {
    console.error(`[MathPipeline] Primary model failed: ${err instanceof Error ? err.message : err}`);
    // If deepseek fails, fall through to verifier model as sole answer
    const fallbackCall: LLMAdapterCall = {
      task: "chat",
      prompt: fullPrompt,
      model_override: VERIFIER_MODEL,
    };
    const fallbackAnswer = await callLLMAdapter(fallbackCall);
    return {
      answer: fallbackAnswer,
      verified: false,
      agreed: false,
      reconciled: false,
      primaryModel: PRIMARY_MODEL,
      verifierModel: VERIFIER_MODEL,
    };
  }

  // ── Skip verification when disabled ──
  if (!VERIFICATION_ENABLED) {
    console.log(`[MathPipeline] verification disabled — returning deepseek answer directly`);
    return {
      answer: primaryAnswer,
      verified: false,
      agreed: false,
      reconciled: false,
      primaryModel: PRIMARY_MODEL,
      verifierModel: VERIFIER_MODEL,
    };
  }

  // ── Step 2: Verification pass with the main chat model ──
  console.log(`[MathPipeline] verification enabled — verifying with ${VERIFIER_MODEL}`);
  const verifierCall: LLMAdapterCall = {
    task: "chat",
    prompt: fullPrompt,
    model_override: VERIFIER_MODEL,
  };

  let verifierAnswer: string;
  try {
    verifierAnswer = await callLLMAdapter(verifierCall);
  } catch (err) {
    console.error(`[MathPipeline] Verifier model failed: ${err instanceof Error ? err.message : err}`);
    // If verifier fails, return primary answer unverified
    return {
      answer: primaryAnswer,
      verified: false,
      agreed: false,
      reconciled: false,
      primaryModel: PRIMARY_MODEL,
      verifierModel: VERIFIER_MODEL,
    };
  }

  // ── Step 3: Compare results ──
  console.log(`[MathPipeline] Step 3: Comparing results`);
  const agreed = answersMatch(primaryAnswer, verifierAnswer);

  if (agreed) {
    console.log(`[MathPipeline] Models agree — returning primary answer`);
    return {
      answer: primaryAnswer,
      verified: true,
      agreed: true,
      reconciled: false,
      primaryModel: PRIMARY_MODEL,
      verifierModel: VERIFIER_MODEL,
    };
  }

  // ── Step 3b: Reconciliation — models disagree ──
  console.log(`[MathPipeline] Models disagree — running reconciliation`);
  const reconciliationPrompt =
    `You are a mathematical verification assistant. Two models were asked the same question and gave different answers.\n\n` +
    `ORIGINAL QUESTION:\n${userMessage}\n\n` +
    `ANSWER A (from ${PRIMARY_MODEL}):\n${primaryAnswer}\n\n` +
    `ANSWER B (from ${VERIFIER_MODEL}):\n${verifierAnswer}\n\n` +
    `TASK: Carefully check the reasoning steps in both answers. Identify which answer is mathematically correct.\n` +
    `If one is clearly correct, return that answer with its full explanation.\n` +
    `If both have errors, provide the correct solution with step-by-step reasoning.\n` +
    `Respond with only the final correct answer and explanation — no meta-commentary about the verification process.`;

  const reconcileCall: LLMAdapterCall = {
    task: "chat",
    prompt: reconciliationPrompt,
    model_override: VERIFIER_MODEL,
  };

  try {
    const reconciledAnswer = await callLLMAdapter(reconcileCall);
    console.log(`[MathPipeline] Reconciliation complete`);
    return {
      answer: reconciledAnswer,
      verified: true,
      agreed: false,
      reconciled: true,
      primaryModel: PRIMARY_MODEL,
      verifierModel: VERIFIER_MODEL,
    };
  } catch (err) {
    console.error(`[MathPipeline] Reconciliation failed: ${err instanceof Error ? err.message : err}`);
    // If reconciliation fails, prefer the primary (deepseek) answer
    return {
      answer: primaryAnswer,
      verified: true,
      agreed: false,
      reconciled: false,
      primaryModel: PRIMARY_MODEL,
      verifierModel: VERIFIER_MODEL,
    };
  }
}
