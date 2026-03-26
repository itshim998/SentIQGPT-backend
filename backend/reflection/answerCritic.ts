// SentIQGPT v2 — Answer Critic (Self-Reflection)
//
// Evaluates an initial AI answer on four dimensions:
//   accuracy, clarity, completeness, relevance
//
// Uses Groq (route_classify) for low-cost, fast evaluation.
// Returns a structured CriticEvaluation with a composite score,
// per-dimension scores, identified issues, and an improve flag.
//
// The critic runs ONCE per answer — no recursive loops.

import {
  callLLMAdapter,
  strictParseJsonObject,
} from "../ai/PromptBuilders";
import type { CriticEvaluation } from "./types";

// Score threshold: answers at or above this skip improvement
const QUALITY_THRESHOLD = 0.82;

/**
 * Evaluate the quality of an AI-generated answer.
 *
 * @param userMessage  The original user query.
 * @param answer       The AI's initial answer to evaluate.
 * @returns            A structured CriticEvaluation.
 */
export async function evaluateAnswer(
  userMessage: string,
  answer: string,
  userId?: string,
): Promise<CriticEvaluation> {
  const prompt =
    "TASK: Answer Quality Evaluation\n" +
    "ROLE: You are a strict quality reviewer for an AI assistant.\n\n" +
    "Evaluate the AI answer against the user's question on these criteria:\n" +
    "- accuracy: Are the facts correct? No hallucinations? (0.0–1.0)\n" +
    "- clarity: Is the answer clearly written and easy to understand? (0.0–1.0)\n" +
    "- completeness: Does it fully address the user's question? (0.0–1.0)\n" +
    "- relevance: Is the content directly relevant to what was asked? (0.0–1.0)\n\n" +
    "RULES:\n" +
    "- Be concise. List only genuine issues, not nitpicks.\n" +
    "- An empty issues array is fine if the answer is good.\n" +
    "- Set improve=true ONLY if score < 0.82 or there are substantive issues.\n" +
    "- Do NOT suggest improvements — only identify problems.\n\n" +
    "USER QUESTION:\n" +
    userMessage +
    "\n\nAI ANSWER:\n" +
    answer.slice(0, 2000) +
    "\n\nRETURN JSON:\n" +
    "{\n" +
    '  "accuracy": 0.0-1.0,\n' +
    '  "clarity": 0.0-1.0,\n' +
    '  "completeness": 0.0-1.0,\n' +
    '  "relevance": 0.0-1.0,\n' +
    '  "issues": ["issue1", ...],\n' +
    '  "improve": true/false\n' +
    "}";

  let raw: string;
  try {
    raw = await callLLMAdapter({
      task: "route_classify",
      prompt,
      prefer: "groq",
      user_id: userId,
    });
  } catch (err) {
    console.log(`[REFLECTION] critic call failed: ${err instanceof Error ? err.message : err}`);
    return defaultPass();
  }

  try {
    return parseEvaluation(raw);
  } catch {
    console.log("[REFLECTION] critic parse failed, defaulting to pass");
    return defaultPass();
  }
}

// ==============================
// Parser
// ==============================

function parseEvaluation(raw: string): CriticEvaluation {
  const parsed = strictParseJsonObject(raw);

  const accuracy = clamp(Number(parsed.accuracy) || 0);
  const clarity = clamp(Number(parsed.clarity) || 0);
  const completeness = clamp(Number(parsed.completeness) || 0);
  const relevance = clamp(Number(parsed.relevance) || 0);

  const score = (accuracy + clarity + completeness + relevance) / 4;

  const issues: string[] = Array.isArray(parsed.issues)
    ? (parsed.issues as unknown[])
        .filter((i): i is string => typeof i === "string" && i.trim().length > 0)
        .slice(0, 5)
    : [];

  const improve =
    typeof parsed.improve === "boolean"
      ? parsed.improve
      : score < QUALITY_THRESHOLD || issues.length > 0;

  return {
    score,
    dimensions: { accuracy, clarity, completeness, relevance },
    issues,
    improve,
  };
}

// ==============================
// Helpers
// ==============================

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Default pass-through when the critic itself fails. */
function defaultPass(): CriticEvaluation {
  return {
    score: 1.0,
    dimensions: { accuracy: 1, clarity: 1, completeness: 1, relevance: 1 },
    issues: [],
    improve: false,
  };
}
