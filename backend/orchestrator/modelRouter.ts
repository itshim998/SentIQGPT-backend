// SentIQGPT v3 — Capability-Aware Model Router
//
// Deterministically selects the best model for a prompt based on
// detected capabilities.  Regex-only — no LLM calls.
//
// Detection priority (first match wins):
//   1. vision          → gemini (Gemini vision-capable model)
//   2. coding          → qwen3-coder   (Pollinations)
//   3. general_chat    → gemini-fast    (Pollinations)
//
// Gemini direct API is NEVER selected by the router.
// It is a last-resort fallback handled by the Python gateway.

export type QueryType = string;

export type PromptModelCategory =
  | "coding"
  | "vision"
  | "math_reasoning"
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

// ── Math / numerical reasoning detection ──
// Checked AFTER vision but BEFORE coding, so that math queries with
// code keywords like "algorithm" route to deepseek instead of qwen3-coder.
const MATH_PATTERNS: readonly RegExp[] = [
  // Arithmetic expressions (digits with operators)
  /\d+\s*[+\-*/^]\s*\d+/,
  // Algebra
  /\balgebra(?:ic)?\b/i,
  /\bequation(?:s)?\b/i,
  /\bsolve\s+(?:for\s+)?[a-z]/i,
  /\bfactor(?:ize|ise)?\b/i,
  /\bsimplif(?:y|ied|ication)\b/i,
  /\bpolynomial\b/i,
  /\bquadratic\b/i,
  /\blinear\s+(?:equation|system|algebra)\b/i,
  // Calculus
  /\bcalculus\b/i,
  /\bintegral(?:s)?\b/i,
  /\bintegrat(?:e|ion)\b/i,
  /\bderivativ(?:e|es)\b/i,
  /\bdifferentiat(?:e|ion)\b/i,
  /\blimit\s+(?:of|as)\b/i,
  /\bseries\s+(?:expansion|convergence)\b/i,
  // Probability & statistics
  /\bprobabilit(?:y|ies)\b/i,
  /\bstatistic(?:s|al)\b/i,
  /\bstandard\s+deviation\b/i,
  /\bvariance\b/i,
  /\bmean\s+(?:of|value)\b/i,
  /\bmedian\b/i,
  /\bcorrelation\b/i,
  /\bregression\b/i,
  /\bbinomial\b/i,
  /\bnormal\s+distribution\b/i,
  /\bBayes(?:ian)?\b/i,
  // Matrices & linear algebra
  /\bmatr(?:ix|ices)\b/i,
  /\bdeterminant\b/i,
  /\beigenvalue\b/i,
  /\beigenvector\b/i,
  /\bvector\s+(?:space|field|product)\b/i,
  // Action verbs for math
  /\bcalculat(?:e|ion)\b/i,
  /\bcompute\b/i,
  /\bprove\s+(?:that|the)\b/i,
  /\bsimplify\b/i,
  /\bevaluat(?:e|ion)\b/i,
  // Math notation / symbols
  /\bsin\s*\(|cos\s*\(|tan\s*\(|log\s*\(/i,
  /\bsqrt\b/i,
  /\bsummation\b/i,
  /\bpermutation(?:s)?\b/i,
  /\bcombination(?:s)?\b/i,
  /\bfactorial\b/i,
  /\bprime\s+number/i,
  /\bgreatest\s+common\b/i,
  /\bleast\s+common\b/i,
  /\bmodular\s+arithmetic\b/i,
  // Generic math keywords
  /\bmath(?:ematic(?:s|al))?\b/i,
  /\bnumerical(?:ly)?\b/i,
  /\barithmetic\b/i,
  /\bgeometr(?:y|ic)\b/i,
  /\btrigonometr(?:y|ic)\b/i,
];

/**
 * Lightweight math query detector.
 * Returns true if the query contains mathematical/numerical reasoning patterns.
 * Exported so it can be reused by the math verification system.
 */
export function isMathQuery(query: string): boolean {
  for (const pattern of MATH_PATTERNS) {
    if (pattern.test(query)) return true;
  }
  return false;
}

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

  // 2. MATH REASONING — any numerical/mathematical signal routes to deepseek.
  //    Checked BEFORE coding so that "solve this algorithm" goes to deepseek.
  if (isMathQuery(query)) {
    return "math_reasoning";
  }

  // 3. CODING — any programming signal routes to qwen3-coder.
  for (const pattern of CODING_PATTERNS) {
    if (pattern.test(query)) {
      return "coding";
    }
  }

  // 3. GENERAL CHAT — everything else → gemini-fast via Pollinations.
  return "general_chat";
}

/**
 * Select the logical model name for the prompt.
 *
 * All primary routes go through Pollinations:
 *   1. qwen3-coder   — coding tasks
 *   2. gemini-fast    — general conversation & lightweight
 *   3. gemini (vision) — image tasks (Gemini direct)
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
    case "math_reasoning":
      model = "deepseek";
      console.log(`[Router] category=math_reasoning → deepseek (Pollinations)`);
      break;
    case "coding":
      model = "qwen3-coder";
      console.log(`[Router] category=coding → qwen3-coder (Pollinations)`);
      break;
    case "general_chat":
    default:
      model = "gemini-fast";
      console.log(`[Router] category=general → gemini-fast (Pollinations)`);
      break;
  }

  console.log(
    `[Router] selected model=${model}  provider=${category === "vision" ? "gemini" : "pollinations"}  category=${category}  query="${query.slice(0, 60)}..."`,
  );
  return model;
}