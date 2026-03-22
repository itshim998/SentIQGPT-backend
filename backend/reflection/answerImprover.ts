// SentIQGPT v2 — Answer Improver (Self-Reflection)
//
// Takes an initial AI answer plus the critic's evaluation and
// produces an improved version that addresses the identified issues.
//
// Uses Gemini (chat task) for high-quality rewriting.
// The improver:
//   • Fixes the specific issues flagged by the critic
//   • Keeps the answer concise
//   • Does NOT add hallucinated information
//   • Preserves citations and structure from the original

import { callLLMAdapterDetailed } from "../ai/PromptBuilders";
import type { CriticEvaluation, ImprovementResult } from "./types";

/**
 * Improve an AI answer based on critic feedback.
 *
 * @param userMessage   The original user query.
 * @param answer        The initial AI answer.
 * @param evaluation    The critic's structured evaluation.
 * @returns             The improved answer (or original on failure).
 */
export async function improveAnswer(
  userMessage: string,
  answer: string,
  evaluation: CriticEvaluation,
): Promise<ImprovementResult> {
  const issueList = evaluation.issues.length > 0
    ? evaluation.issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")
    : "General quality improvement needed.";

  const prompt =
    "TASK: Answer Improvement\n" +
    "ROLE: You are rewriting an AI answer to fix specific quality issues.\n\n" +
    "RULES:\n" +
    "- Fix ONLY the issues listed below. Do not add unrelated content.\n" +
    "- Do NOT introduce new facts that weren't in the original answer or question.\n" +
    "- Keep the answer concise — do not make it significantly longer.\n" +
    "- Preserve any citations, source references, or formatting.\n" +
    "- If the answer uses [Source N] citations, keep them.\n" +
    "- Return ONLY the improved answer text, no meta-commentary.\n\n" +
    "USER QUESTION:\n" +
    userMessage +
    "\n\nORIGINAL ANSWER:\n" +
    answer.slice(0, 3000) +
    "\n\nISSUES TO FIX:\n" +
    issueList +
    "\n\nQUALITY SCORES: " +
    `accuracy=${evaluation.dimensions.accuracy.toFixed(2)}, ` +
    `clarity=${evaluation.dimensions.clarity.toFixed(2)}, ` +
    `completeness=${evaluation.dimensions.completeness.toFixed(2)}, ` +
    `relevance=${evaluation.dimensions.relevance.toFixed(2)}` +
    "\n\nIMPROVED ANSWER:";

  try {
    const improved = await callLLMAdapterDetailed({
      task: "chat",
      prompt,
      prefer: "gemini",
    });

    const trimmed = improved.text.trim();

    // Sanity check: if the improved answer is empty or drastically shorter, keep original
    if (!trimmed || trimmed.length < answer.length * 0.3) {
      console.log("[REFLECTION] improved answer too short, keeping original");
      return { answer, improved: false };
    }

    console.log("[REFLECTION] improvement applied");
    return {
      answer: trimmed,
      improved: true,
      model_used: improved.model_used,
      fallback: improved.fallback ?? false,
      changeNote: `Fixed ${evaluation.issues.length} issue(s): ${evaluation.issues.join("; ").slice(0, 120)}`,
    };
  } catch (err) {
    console.log(`[REFLECTION] improver failed: ${err instanceof Error ? err.message : err}`);
    return { answer, improved: false };
  }
}
