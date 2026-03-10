// SentIQGPT v2 — Smart Model Router
//
// Deterministically selects the best logical text model for a prompt.
// This is intentionally lightweight: regex checks only, no LLM calls.
//
// Logical routes (priority order):
//   1. coding          -> qwen3-coder       (Pollinations) — checked FIRST
//   2. lightweight     -> gpt-5-nano        (Pollinations)
//   3. search_grounded -> gemini-search     (Gemini, search-grounded)
//   4. general_chat    -> gpt-5-nano        (Pollinations) — Gemini is last resort

import type { QueryCategory } from "./queryClassifier";

export type QueryType = QueryCategory;

export type PromptModelCategory =
  | "coding"
  | "lightweight"
  | "search_grounded"
  | "general_chat";

// Coding detection — checked BEFORE any other category.
// If a query matches any pattern here it is always routed to qwen3-coder.
const CODING_PATTERNS: readonly RegExp[] = [
  // Core coding keywords
  /\bcode\b/i,
  /\bprogram\b/i,
  /\bscript\b/i,
  /\bfunction\b/i,
  /\bclass\b/i,
  /\balgorithm\b/i,
  /\bcompile\b/i,
  /\bdebug\b/i,
  /\bimplementation\b/i,
  /\bexample\b/i,
  /\bsnippet\b/i,
  // Programming languages
  /\b[Cc]\+\+\b/,
  /\b[Cc]#\b/,
  /\bjava\b/i,
  /\bpython\b/i,
  /\bjavascript\b/i,
  /\btypescript\b/i,
  /\bgolang\b/i,
  /\brust\b/i,
  /\bhtml\b/i,
  /\bcss\b/i,
  /\bsql\b/i,
  // Action verbs paired with coding output
  /\bwrite\s+(?:a\s+)?(?:code|program|script|function|class|method|module|test)\b/i,
  /\bwrite\s+(?:a\s+)?(?:go|golang)\s+(?:program|script|function|class|module)\b/i,
  /\bbuild\s+(?:a\s+)?(?:code|program|script|app|application|class|module)\b/i,
  /\bcreate\s+(?:a\s+)?(?:code|program|script|function|class|component|module)\b/i,
  /\bimplement(?:ation)?\s+(?:a\s+|the\s+)?(?:code|program|script|function|class|algorithm|solution)\b/i,
  /\bgenerate\s+(?:a\s+)?(?:code|program|script|function|class|test)\b/i,
  /\bdesign\s+(?:a\s+)?(?:code|program|class|algorithm|system)\b/i,
  // Diagnostic indicators
  /\bstack\s*trace\b/i,
  /\bfix\s+(?:this\s+)?(?:code|bug|error|exception)\b/i,
  /\brefactor\b/i,
  /\bexception\b/i,
  /```/,
  /\bbug\b/i,
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
  // 1. Coding detection runs FIRST — takes priority over all other categories.
  //    Any query mentioning a programming language or coding keyword is coding.
  for (const pattern of CODING_PATTERNS) {
    if (pattern.test(query)) {
      return "coding";
    }
  }

  // 2. Search-grounded queries need real-time data via Gemini Search.
  if (
    classification === "real_time_information" ||
    classification === "factual_lookup"
  ) {
    return "search_grounded";
  }

  // 3. Lightweight utility prompts.
  for (const pattern of LIGHTWEIGHT_PATTERNS) {
    if (pattern.test(query)) {
      return "lightweight";
    }
  }

  // Short, low-complexity utility prompts can use the lightweight model.
  if (query.trim().length < 120 && /\b(?:summarize|rewrite|title|keywords?|brief|compress|short)\b/i.test(query)) {
    return "lightweight";
  }

  // 4. Everything else — route to Pollinations (gpt-5-nano), not Gemini.
  return "general_chat";
}

/**
 * Select the logical model name for the prompt.
 *
 * Priority order:
 *   1. Pollinations qwen3-coder  — all coding tasks
 *   2. Pollinations gpt-5-nano   — lightweight prompts & general chat
 *   3. Gemini gemini-search      — only for search-grounded queries
 *   4. Gemini gemini-fast        — LAST RESORT (never selected here directly)
 *
 * The Python gateway resolves these logical names to concrete provider/model
 * combinations and applies provider-safe fallback when a target model is not
 * available in the current deployment.
 */
export function selectModelForPrompt(query: string, classification?: QueryType): string {
  const category = detectPromptCategory(query, classification);
  let model: string;
  switch (category) {
    case "coding":
      model = "qwen3-coder";
      console.log(`[Router] category=coding → qwen3-coder`);
      break;
    case "lightweight":
      model = "gpt-5-nano";
      console.log(`[Router] category=lightweight → gpt-5-nano`);
      break;
    case "search_grounded":
      model = "gemini-search";
      console.log(`[Router] category=search_grounded → gemini-search`);
      break;
    case "general_chat":
    default:
      // Prefer Pollinations for general chat; Gemini is a last resort fallback only.
      model = "gpt-5-nano";
      console.log(`[Router] category=general_chat → gpt-5-nano (Pollinations)`);
      break;
  }
  console.log(`[Router] selected model: ${model} (category: ${category}, query: "${query.slice(0, 60)}...")`);
  return model;
}