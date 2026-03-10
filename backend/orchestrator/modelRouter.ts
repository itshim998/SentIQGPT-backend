// SentIQGPT v3 — Capability-Aware Model Router
//
// Deterministically selects the best model for a prompt based on
// detected capabilities.  Regex-only — no LLM calls.
//
// Detection priority (first match wins):
//   1. vision          → gemini (Gemini vision-capable model)
//   2. coding          → qwen3-coder   (Pollinations)
//   3. search          → gemini-search  (Pollinations)
//   4. general_chat    → gemini-fast    (Pollinations)
//
// Gemini direct API is NEVER selected by the router.
// It is a last-resort fallback handled by the Python gateway.

import type { QueryCategory } from "./queryClassifier";

export type QueryType = QueryCategory;

export type PromptModelCategory =
  | "coding"
  | "vision"
  | "search"
  | "general_chat";

// ── Coding detection ──
// Checked BEFORE general chat.  Any programming language name OR coding
// keyword forces routing to qwen3-coder.
const CODING_PATTERNS: readonly RegExp[] = [
  // Core coding keywords
  /\bcode\b/i,
  /\bprogram(?:ming)?\b/i,
  /\bscript\b/i,
  /\bfunction\b/i,
  /\bclass\b/i,
  /\balgorithm\b/i,
  /\bcompil(?:e|er)\b/i,
  /\bdebug(?:ging)?\b/i,
  /\bimplementation\b/i,
  /\bsnippet\b/i,
  /\bAPI\b/,
  /\bSDK\b/i,
  /\bregex\b/i,
  /\bquery\b/i,
  /\bsyntax\b/i,
  /\bloop\b/i,
  /\barray\b/i,
  /\bvariable\b/i,
  /\bpointer\b/i,
  /\brecursion\b/i,
  // Programming languages
  /\b[Cc]\+\+\b/,
  /\b[Cc]#\b/,
  /\bjava\b/i,
  /\bpython\b/i,
  /\bjavascript\b/i,
  /\btypescript\b/i,
  /\bgolang\b/i,
  /\b\bgo\s+(?:program|code|function|module)\b/i,
  /\brust\b/i,
  /\bhtml\b/i,
  /\bcss\b/i,
  /\bsql\b/i,
  /\bswift\b/i,
  /\bkotlin\b/i,
  /\bruby\b/i,
  /\bphp\b/i,
  /\bperl\b/i,
  /\bscala\b/i,
  /\bhaskell\b/i,
  /\blua\b/i,
  /\bR\b(?=\s+(?:code|program|script|function))/,
  /\bbash\b/i,
  /\bshell\b/i,
  /\bpowershell\b/i,
  // Action verbs paired with code output
  /\bwrite\s+(?:a\s+)?(?:code|program|script|function|class|method|module|test)\b/i,
  /\bbuild\s+(?:a\s+)?(?:code|program|script|app|application|class|module)\b/i,
  /\bcreate\s+(?:a\s+)?(?:code|program|script|function|class|component|module|webpage|page)\b/i,
  /\bimplement\s+(?:a\s+|the\s+)?/i,
  /\bgenerate\s+(?:a\s+)?(?:code|program|script|function|class|test)\b/i,
  /\bdesign\s+(?:a\s+)?(?:code|program|class|algorithm|system)\b/i,
  // Diagnostic indicators
  /\bstack\s*trace\b/i,
  /\bfix\s+(?:this\s+)?(?:code|bug|error|exception)\b/i,
  /\brefactor\b/i,
  /\bexception\b/i,
  /```/,
  /\bbug\b/i,
  /\bunit\s*test\b/i,
];

// ── Vision detection ──
// If an image is involved the query MUST go to a vision-capable model.
const VISION_PATTERNS: readonly RegExp[] = [
  /\bdescribe\s+(?:this\s+)?image\b/i,
  /\bwhat\s+is\s+in\s+(?:this\s+)?image\b/i,
  /\banalyze\s+(?:this\s+)?(?:image|photo|picture|screenshot)\b/i,
  /\bwhat\s+does\s+(?:this\s+)?(?:image|photo|picture)\s+show\b/i,
  /\blocr\b/i,
  /\bread\s+(?:the\s+)?text\s+(?:in|from)\b/i,
  /\bextract\s+(?:text|data)\s+from\s+(?:this\s+)?(?:image|photo|screenshot)\b/i,
];

// ── Web search detection ──
// Queries needing current or real-time information.
const SEARCH_PATTERNS: readonly RegExp[] = [
  /\blatest\b/i,
  /\bcurrent(?:ly)?\b/i,
  /\btoday\b/i,
  /\brecent(?:ly)?\b/i,
  /\bnews\b/i,
  /\bannouncement\b/i,
  /\bprice\b/i,
  /\bstatistics\b/i,
  /\btrending\b/i,
  /\bwho\s+won\b/i,
  /\bscore\b/i,
  /\bweather\b/i,
  /\bstock\b/i,
  /\bupdate[sd]?\b/i,
  /\b20(?:2[5-9]|[3-9]\d)\b/,
];

interface RouterOptions {
  hasImage?: boolean;
  hasFile?: boolean;
}

function detectPromptCategory(
  query: string,
  classification?: QueryType,
  options?: RouterOptions,
): PromptModelCategory {
  // 1. VISION — highest priority.  Image presence forces vision model.
  if (options?.hasImage) {
    return "vision";
  }
  for (const pattern of VISION_PATTERNS) {
    if (pattern.test(query)) {
      return "vision";
    }
  }

  // 1.5. FILE ANALYSIS — file input forces gemini-fast for large-context handling.
  if (options?.hasFile) {
    console.log(`[Router] file_input_detected → gemini-fast`);
    return "general_chat";
  }

  // 2. CODING — any programming signal routes to qwen3-coder.
  for (const pattern of CODING_PATTERNS) {
    if (pattern.test(query)) {
      return "coding";
    }
  }

  // 3. SEARCH — queries needing current information.
  if (
    classification === "real_time_information" ||
    classification === "factual_lookup"
  ) {
    return "search";
  }
  for (const pattern of SEARCH_PATTERNS) {
    if (pattern.test(query)) {
      return "search";
    }
  }

  // 4. GENERAL CHAT — everything else → gemini-fast via Pollinations.
  return "general_chat";
}

/**
 * Select the logical model name for the prompt.
 *
 * All primary routes go through Pollinations:
 *   1. qwen3-coder   — coding tasks
 *   2. gemini-search  — queries needing current data
 *   3. gemini-fast    — general conversation & lightweight
 *   4. gemini (vision) — image tasks (Gemini direct)
 *
 * Gemini direct API is ONLY used for vision or as a last-resort fallback
 * (handled by the Python gateway, not selected here).
 */
export function selectModelForPrompt(
  query: string,
  classification?: QueryType,
  options?: RouterOptions,
): string {
  const category = detectPromptCategory(query, classification, options);
  let model: string;

  switch (category) {
    case "vision":
      model = "gemini-vision";
      console.log(`[Router] category=vision → gemini (vision model)`);
      break;
    case "coding":
      model = "qwen3-coder";
      console.log(`[Router] category=coding → qwen3-coder (Pollinations)`);
      break;
    case "search":
      model = "gemini-search";
      console.log(`[Router] category=search → gemini-search (Pollinations)`);
      break;
    case "general_chat":
    default:
      model = "gemini-fast";
      console.log(`[Router] category=general → gemini-fast (Pollinations)`);
      break;
  }

  console.log(
    `[Router] selected model=${model}  provider=${category === "vision" ? "gemini" : "pollinations"}  query="${query.slice(0, 60)}..."`,
  );
  return model;
}