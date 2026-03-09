// SentIQGPT v2 — Smart Model Router
//
// Deterministically selects the best logical text model for a prompt.
// This is intentionally lightweight: regex checks only, no LLM calls.
//
// Logical routes:
//   - general_chat   -> gemini-fast
//   - search_grounded -> gemini-search
//   - coding         -> qwen3-coder-30b
//   - lightweight    -> gpt-5-nano

import type { QueryCategory } from "./queryClassifier";

export type QueryType = QueryCategory;

export type PromptModelCategory =
  | "coding"
  | "lightweight"
  | "search_grounded"
  | "general_chat";

const CODING_PATTERNS: readonly RegExp[] = [
  /\bcode\b/i,
  /\bdebug\b/i,
  /\bfunction\b/i,
  /\bclass\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bpython\b/i,
  /\balgorithm\b/i,
  /\bstack\s*trace\b/i,
  /\berror\b/i,
  /\bcompile\b/i,
  /\bfix\s+this\s+code\b/i,
  /```/,
  /\bbug\b/i,
  /\brefactor\b/i,
  /\bexception\b/i,
];

const LIGHTWEIGHT_PATTERNS: readonly RegExp[] = [
  /\bsummarize\b/i,
  /\brewrite\b/i,
  /\btitle\b/i,
  /\bshort\s+answer\b/i,
  /\blist\s+keywords\b/i,
  /\bkeywords\b/i,
  /\bcompress\s+memory\b/i,
  /\btl;dr\b/i,
  /\bbriefly\b/i,
  /\bin\s+one\s+sentence\b/i,
];

function detectPromptCategory(query: string, classification?: QueryType): PromptModelCategory {
  if (
    classification === "real_time_information" ||
    classification === "factual_lookup"
  ) {
    return "search_grounded";
  }

  for (const pattern of CODING_PATTERNS) {
    if (pattern.test(query)) {
      return "coding";
    }
  }

  for (const pattern of LIGHTWEIGHT_PATTERNS) {
    if (pattern.test(query)) {
      return "lightweight";
    }
  }

  // Short, low-complexity utility prompts can use the lightweight model.
  if (query.trim().length < 120 && /\b(?:summarize|rewrite|title|keywords?|brief|compress|short)\b/i.test(query)) {
    return "lightweight";
  }

  return "general_chat";
}

/**
 * Select the logical model name for the prompt.
 *
 * The Python gateway resolves these logical names to concrete provider/model
 * combinations and applies provider-safe fallback when a target model is not
 * available in the current deployment.
 */
export function selectModelForPrompt(query: string, classification?: QueryType): string {
  switch (detectPromptCategory(query, classification)) {
    case "coding":
      return "qwen3-coder-30b";
    case "lightweight":
      return "gpt-5-nano";
    case "search_grounded":
      return "gemini-search";
    case "general_chat":
    default:
      return "gemini-fast";
  }
}