// SentIQGPT v3 - Capability-Aware Model Router
//
// Deterministically selects the best model for a prompt based on
// detected capabilities. Regex-only - no LLM calls.
//
// Detection priority (first match wins):
//   1. vision              -> gemini-fast (Pollinations) - native vision support
//   2. file (coding PDF)   -> qwen-coder (Pollinations) - coding PDFs get code model
//   3. file (non-coding)   -> gemini-fast (Pollinations) - preserve file pipeline
//   4. coding              -> qwen-coder (Pollinations)
//   5. math_reasoning      -> openai-large (Pollinations)
//   6. general_chat        -> gemini-fast (Pollinations) - human-like conversations
//
// Gemini direct API is NEVER selected by the router.
// It is a last-resort fallback handled by the Python gateway.

export type QueryType = string;

export type PromptModelCategory =
  | "coding"
  | "vision"
  | "math_reasoning"
  | "general_chat"
  | "file_coding"
  | "file_general";

// Coding detection must run before math detection so debugging prompts
// do not get intercepted by the math pipeline.
const CODE_LANGUAGE_PATTERNS: readonly RegExp[] = [
  /\bpython\b/i,
  /\bjava\b/i,
  /\bjavascript\b/i,
  /\btypescript\b/i,
  /\bcpp\b/i,
  /\bc\+\+\b/i,
  /\bc\b(?=\s+(?:code|program|compiler|function|bug|error|pointer|syntax|language|file)\b)/i,
];

const CODE_SYNTAX_PATTERNS: readonly RegExp[] = [
  /\bdef\s+[A-Za-z_]\w*\s*\(/i,
  /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/i,
  /\bclass\s+[A-Za-z_]\w*/i,
  /\breturn\b/i,
  /\bprint\s*\(/i,
  /\binput\s*\(/i,
  /\bconsole\.log\s*\(/i,
];

const CODE_STRUCTURE_PATTERNS: readonly RegExp[] = [
  /```/,
  /[A-Za-z_]\w*\s*\([^)\n]*\)/,
  /\{[^}]*\}/,
  /(?:^|\n)(?:\t| {2,})\S/m,
  /:\s*(?:\r?\n)\s{2,}\S/m,
];

const CODE_DEBUG_PATTERNS: readonly RegExp[] = [
  /\berror\b/i,
  /\bbug\b/i,
  /\bnot\s+working\b/i,
  /\bnot\s+printing\b/i,
  /\bfix\b/i,
  /\bissue\b/i,
  /\bdebug(?:ging)?\b/i,
  /\bexception\b/i,
];

const GENERIC_CODING_PATTERNS: readonly RegExp[] = [
  /\bcode\b/i,
  /\bprogram(?:ming)?\b/i,
  /\bscript\b/i,
  /\bcompiler?\b/i,
  /\bsyntax\b/i,
  /\bstack\s*trace\b/i,
  /\brefactor\b/i,
  /\bunit\s*test\b/i,
  /\bapi\b/i,
  /\bsdk\b/i,
];

const BUILD_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(?:code|build|create|develop)\b/i,
  /\bdesign\s+and\s+build\b/i,
];

const BUILD_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /\bhtml\s+page\b/i,
  /\bwebsite\b/i,
  /\bportfolio\b/i,
  /\blanding\s+page\b/i,
  /\bapp\b/i,
  /\bcomponent\b/i,
  /\bui\b/i,
];

const FRONTEND_STACK_PATTERNS: readonly RegExp[] = [
  /\bnext\.js\b/i,
  /\breact\b/i,
  /\btailwind\b/i,
  /\bgsap\b/i,
  /\bframer\s+motion\b/i,
  /\bthree\.js\b/i,
  /\btypescript\b/i,
];

// Math / numerical reasoning detection.
// Checked after coding so programming prompts never leak into openai-large.
const MATH_PATTERNS: readonly RegExp[] = [
  /\d+\s*[+\-*/^]\s*\d+/,
  /\balgebra(?:ic)?\b/i,
  /\bequation(?:s)?\b/i,
  /\bsolve\b/i,
  /\bfactor(?:ize|ise)?\b/i,
  /\bsimplif(?:y|ied|ication)\b/i,
  /\bpolynomial\b/i,
  /\bquadratic\b/i,
  /\blinear\s+(?:equation|system|algebra)\b/i,
  /\bcalculus\b/i,
  /\bintegral(?:s)?\b/i,
  /\bintegrat(?:e|ion)\b/i,
  /\bderivativ(?:e|es)\b/i,
  /\bdifferentiat(?:e|ion)\b/i,
  /\blimit\s+(?:of|as)\b/i,
  /\bseries\s+(?:expansion|convergence)\b/i,
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
  /\bmatr(?:ix|ices)\b/i,
  /\bdeterminant\b/i,
  /\beigenvalue\b/i,
  /\beigenvector\b/i,
  /\bvector\s+(?:space|field|product)\b/i,
  /\bcalculat(?:e|ion)\b/i,
  /\bcompute\b/i,
  /\bprove\s+(?:that|the)\b/i,
  /\bsimplify\b/i,
  /\bevaluat(?:e|ion)\b/i,
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
  /\bmath(?:ematic(?:s|al))?\b/i,
  /\bnumerical(?:ly)?\b/i,
  /\barithmetic\b/i,
  /\bgeometr(?:y|ic)\b/i,
  /\btrigonometr(?:y|ic)\b/i,
];

const LOGIC_REASONING_PATTERNS: readonly RegExp[] = [
  /\blogic(?:al)?\s+(?:puzzle|problem|question|reasoning)\b/i,
  /\briddle\b/i,
  /\bsyllogism\b/i,
  /\btruth\s+table\b/i,
  /\bpropositional\s+logic\b/i,
  /\bpredicate\s+logic\b/i,
  /\bmodus\s+ponens\b/i,
  /\bmodus\s+tollens\b/i,
  /\bif\b[\s\S]{0,30}\bthen\b[\s\S]{0,30}\btherefore\b/i,
  /\bwhich\s+(?:statement|conclusion)\s+(?:must|necessarily)\s+be\s+true\b/i,
  /\bdoes\s+it\s+follow\s+that\b/i,
  /\bprove\s+or\s+disprove\b/i,
  /\bshow\s+that\b/i,
  /\bprove\s+that\b/i,
  /\bcontradiction\b/i,
  /\bcontrapositive\b/i,
  /\bnecessary\s+and\s+sufficient\b/i,
  /\bcan\s+you\s+deduce\b/i,
];

const WORD_PROBLEM_CONSTRAINT_WORDS: readonly RegExp[] = [
  /\bprofit\b/i,
  /\bcost\b/i,
  /\bproduction\b/i,
  /\bfactory\b/i,
  /\bmachines?\b/i,
  /\bhours?\b/i,
  /\bresources?\b/i,
  /\bconstraints?\b/i,
  /\bbudget\b/i,
  /\bdistance\b/i,
  /\bspeed\b/i,
  /\brate\b/i,
  /\bpercentage\b/i,
  /\bincrease\b/i,
  /\bdecrease\b/i,
  /\bworkers?\b/i,
  /\bcapacity\b/i,
  /\bsupply\b/i,
  /\bdemand\b/i,
  /\binventory\b/i,
  /\bunits?\b/i,
  /\bquantity\b/i,
  /\bprice\b/i,
  /\brevenue\b/i,
  /\bwages?\b/i,
  /\bsalary\b/i,
  /\blabou?r\b/i,
  /\binterest\b/i,
  /\binvestment\b/i,
  /\bweight\b/i,
  /\bvolume\b/i,
  /\barea\b/i,
  /\blength\b/i,
  /\bwidth\b/i,
  /\bheight\b/i,
  /\bratio\b/i,
  /\bproportion\b/i,
];

const WORD_PROBLEM_GOAL_PHRASES: readonly RegExp[] = [
  /\bmaximiz(?:e|ing)\b/i,
  /\bminimiz(?:e|ing)\b/i,
  /\boptimiz(?:e|ing|ation)\b/i,
  /\bhow\s+many\b/i,
  /\bhow\s+much\b/i,
  /\bhow\s+long\b/i,
  /\bhow\s+far\b/i,
  /\bhow\s+fast\b/i,
  /\bfind\s+the\b/i,
  /\bwhat\s+is\s+the\s+(?:total|maximum|minimum|average|sum|difference|product)\b/i,
  /\bdetermine\b/i,
  /\bshould\s+be\s+produced\b/i,
  /\bshould\s+.*\b(?:buy|sell|make|produce|allocate|invest|hire)\b/i,
  /\bwhat\s+(?:fraction|percent(?:age)?|proportion)\b/i,
];

const STRUCTURAL_COMPARISON_WORDS: readonly RegExp[] = [
  /\bat\s+least\b/i,
  /\bat\s+most\b/i,
  /\bno\s+more\s+than\b/i,
  /\bno\s+less\s+than\b/i,
  /\bno\s+fewer\s+than\b/i,
  /\btwice\s+as\s+many\b/i,
  /\bthree\s+times\b/i,
  /\bhalf\s+(?:of|as)\b/i,
  /\bmaximum\b/i,
  /\bminimum\b/i,
  /\bnot\s+(?:to\s+)?exceed\b/i,
  /\bgreater\s+than\b/i,
  /\bless\s+than\b/i,
  /\bequal\s+to\b/i,
  /\btotal\s+(?:of|is)\b/i,
  /\blimited\s+to\b/i,
  /\bavailable\b/i,
  /\brequires?\b/i,
  /\beach\b/i,
  /\bper\b/i,
];

function countNumbers(query: string): number {
  const matches = query.match(/\b\d+(?:\.\d+)?(?:\/\d+)?\b/g);
  return matches ? matches.length : 0;
}

function countMatches(query: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(query)) count++;
  }
  return count;
}

export function detectCodeQuery(query: string): boolean {
  if (!query.trim()) return false;

  const languageHits = countMatches(query, CODE_LANGUAGE_PATTERNS);
  const syntaxHits = countMatches(query, CODE_SYNTAX_PATTERNS);
  const structureHits = countMatches(query, CODE_STRUCTURE_PATTERNS);
  const debugHits = countMatches(query, CODE_DEBUG_PATTERNS);
  const genericHits = countMatches(query, GENERIC_CODING_PATTERNS);
  const buildHits = countMatches(query, BUILD_REQUEST_PATTERNS);
  const artifactHits = countMatches(query, BUILD_ARTIFACT_PATTERNS);
  const stackHits = countMatches(query, FRONTEND_STACK_PATTERNS);

  if (/```/.test(query)) return true;
  if (languageHits > 0) return true;
  if (buildHits > 0 && artifactHits > 0) return true;
  if (buildHits > 0 && stackHits > 0) return true;
  if (artifactHits > 0 && stackHits >= 2) return true;
  if (syntaxHits >= 2) return true;
  if (syntaxHits > 0 && (debugHits > 0 || structureHits > 0 || genericHits > 0)) return true;
  if (debugHits > 0 && (syntaxHits > 0 || structureHits > 0 || genericHits > 0)) return true;
  if (genericHits >= 2 && (syntaxHits > 0 || structureHits > 0 || debugHits > 0)) return true;
  if (structureHits >= 2 && (syntaxHits > 0 || debugHits > 0 || genericHits > 0)) return true;

  return false;
}

export function detectMathReasoning(query: string): boolean {
  if (detectCodeQuery(query)) {
    return false;
  }

  for (const pattern of MATH_PATTERNS) {
    if (pattern.test(query)) return true;
  }

  const numCount = countNumbers(query);

  if (numCount >= 2) {
    const constraintHits = countMatches(query, WORD_PROBLEM_CONSTRAINT_WORDS);
    const goalHits = countMatches(query, WORD_PROBLEM_GOAL_PHRASES);
    if (constraintHits >= 2 && goalHits >= 1) return true;
  }

  if (numCount >= 2) {
    const structuralHits = countMatches(query, STRUCTURAL_COMPARISON_WORDS);
    const goalHits = countMatches(query, WORD_PROBLEM_GOAL_PHRASES);
    if (structuralHits >= 2 && goalHits >= 1) return true;
  }

  if (
    /\b(?:maximiz|minimiz|optimiz)(?:e|ing|ation)\b/i.test(query) &&
    numCount >= 1 &&
    countMatches(query, WORD_PROBLEM_CONSTRAINT_WORDS) >= 1
  ) {
    return true;
  }

  return false;
}

export function isMathQuery(query: string): boolean {
  return detectMathReasoning(query);
}

export function detectLogicReasoning(query: string): boolean {
  if (detectCodeQuery(query)) {
    return false;
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return false;
  }

  if (LOGIC_REASONING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }

  const implicationHits = countMatches(trimmed, [
    /\bif\b/i,
    /\bthen\b/i,
    /\btherefore\b/i,
    /\bassume\b/i,
    /\bimplies\b/i,
    /\bconclude\b/i,
  ]);
  const proofHits = countMatches(trimmed, [
    /\bmust\b/i,
    /\balways\b/i,
    /\bnever\b/i,
    /\bvalid\b/i,
    /\binvalid\b/i,
    /\bconsistent\b/i,
    /\binconsistent\b/i,
  ]);

  return implicationHits >= 2 && proofHits >= 1;
}

export function isBufferedReasoningQuery(query: string): boolean {
  return isMathQuery(query) || detectLogicReasoning(query);
}

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
  /** Extracted text content from uploaded files (for coding PDF detection) */
  fileContent?: string;
  /** Filenames of uploaded files (for coding PDF detection) */
  fileNames?: string[];
}

// ==============================
// Coding PDF Detection
// ==============================

/** Patterns indicating a PDF contains programming/coding content */
const PDF_CODING_FILENAME_PATTERNS: readonly RegExp[] = [
  /code/i,
  /programming/i,
  /algorithm/i,
  /data\s*struct/i,
  /software/i,
  /developer/i,
  /python/i,
  /java(?:script)?/i,
  /typescript/i,
  /c\+\+/i,
  /rust/i,
  /golang/i,
  /react/i,
  /angular/i,
  /vue/i,
  /node/i,
  /api/i,
  /backend/i,
  /frontend/i,
  /fullstack/i,
  /leetcode/i,
  /hackerrank/i,
  /coding/i,
  /tutorial/i,
  /cheatsheet/i,
  /documentation/i,
  /reference/i,
];

/**
 * Detects if uploaded PDF content is coding-related.
 * Checks both filename patterns and extracted text content.
 */
export function isCodingPDF(fileNames?: string[], fileContent?: string): boolean {
  // Check filenames for coding indicators
  if (fileNames && fileNames.length > 0) {
    for (const name of fileNames) {
      const lowerName = name.toLowerCase();
      // Only check PDFs
      if (!lowerName.endsWith(".pdf")) continue;
      
      for (const pattern of PDF_CODING_FILENAME_PATTERNS) {
        if (pattern.test(lowerName)) {
          console.log(`[Router] coding PDF detected by filename: ${name}`);
          return true;
        }
      }
    }
  }

  // Check extracted content for code patterns
  if (fileContent && fileContent.length > 0) {
    // Use existing code detection on file content
    if (detectCodeQuery(fileContent)) {
      console.log("[Router] coding PDF detected by content analysis");
      return true;
    }

    // Additional PDF-specific code indicators (more lenient for extracted text)
    const codeIndicatorCount = countMatches(fileContent, [
      ...CODE_LANGUAGE_PATTERNS,
      ...CODE_SYNTAX_PATTERNS,
      ...GENERIC_CODING_PATTERNS,
    ]);
    
    // If multiple code indicators found in PDF content, treat as coding PDF
    if (codeIndicatorCount >= 3) {
      console.log(`[Router] coding PDF detected by indicator count: ${codeIndicatorCount}`);
      return true;
    }
  }

  return false;
}

function detectPromptCategory(
  query: string,
  classification?: QueryType,
  options?: RouterOptions,
): PromptModelCategory {
  void classification;

  // Priority 1: Vision (images)
  if (options?.hasImage) {
    return "vision";
  }

  for (const pattern of VISION_PATTERNS) {
    if (pattern.test(query)) {
      return "vision";
    }
  }

  // Priority 2 & 3: Files (coding PDFs vs general files)
  // File override takes HIGHEST priority after vision
  if (options?.hasFile) {
    // Check if the PDF is coding-related
    if (isCodingPDF(options.fileNames, options.fileContent)) {
      console.log("[Router] file_input_detected (coding PDF) -> qwen-coder");
      return "file_coding";
    }
    console.log("[Router] file_input_detected (non-coding) -> gemini-fast");
    return "file_general";
  }

  // Priority 4: Coding queries (no files)
  if (detectCodeQuery(query)) {
    return "coding";
  }

  // Priority 5: Math queries
  if (isMathQuery(query)) {
    return "math_reasoning";
  }

  // Priority 6: General chat (default) -> gemini-fast for human-like conversations
  return "general_chat";
}

export function selectModelForPrompt(
  query: string,
  classification?: QueryType,
  options?: RouterOptions,
): string {
  const category = detectPromptCategory(query, classification, options);
  let model: string;

  switch (category) {
    case "vision":
      model = "gemini-fast";
      console.log("[Router] category=vision -> gemini-fast");
      break;
    case "file_coding":
      model = "qwen-coder";
      console.log("[Router] category=file_coding -> qwen-coder");
      break;
    case "file_general":
      model = "gemini-fast";
      console.log("[Router] category=file_general -> gemini-fast");
      break;
    case "coding":
      model = "qwen-coder";
      console.log("[Router] category=coding -> qwen-coder");
      break;
    case "math_reasoning":
      model = "openai-large";
      console.log("[Router] category=math_reasoning -> openai-large");
      break;
    case "general_chat":
    default:
      model = "gemini-fast";
      console.log("[Router] category=general_chat -> gemini-fast");
      break;
  }

  const provider = category === "vision" ? "gemini" : "pollinations";
  console.log(
    `[Router] selected model=${model} provider=${provider} category=${category} query="${query.slice(0, 60)}..."`,
  );
  return model;
}
