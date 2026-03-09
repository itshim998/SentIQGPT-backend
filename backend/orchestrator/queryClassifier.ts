// SentIQGPT v2 — Deterministic Query Classifier
//
// Runs BEFORE the LLM planner to detect when web search is clearly
// required.  Uses keyword / pattern matching — zero LLM cost, < 1ms.
//
// Categories:
//   general_knowledge    — answerable from training data
//   real_time_information — current events, scores, news, live data
//   factual_lookup       — medicines, products, entities, documentation
//   personal_context     — references the user's own data / memory
//   image_generation     — explicit image creation request
//
// When the category is real_time_information or factual_lookup the
// orchestrator / streaming endpoint must perform a web search before
// calling the reasoning model.

// ==============================
// Types
// ==============================

export type QueryCategory =
  | "general_knowledge"
  | "real_time_information"
  | "factual_lookup"
  | "personal_context"
  | "image_generation";

export interface QueryClassification {
  readonly category: QueryCategory;
  readonly needsWebSearch: boolean;
  /** Which rule matched (for logging) */
  readonly matchedRule: string;
}

// ==============================
// Pattern banks
// ==============================

/** Time-sensitive / current-events patterns */
const REALTIME_PATTERNS: readonly RegExp[] = [
  /\b(?:current|latest|recent|today|yesterday|tonight|this\s+(?:week|month|year)|right\s+now|as\s+of)\b/i,
  /\b(?:who\s+won|who\s+is\s+winning|score|results?\s+of|standings?|live|breaking\s+news)\b/i,
  /\b(?:world\s+cup|ipl|olympics|super\s+bowl|grammy|oscar|emmy|ballon\s+d'or|grand\s+slam)\b/i,
  /\b(?:election|president\s+of|prime\s+minister\s+of|leader\s+of)\b/i,
  /\b(?:stock\s+price|share\s+price|market\s+cap|exchange\s+rate|bitcoin\s+price|crypto\s+price)\b/i,
  /\b(?:weather\s+(?:in|for|today|forecast)|temperature\s+in)\b/i,
  /\b(?:trending|viral|just\s+(?:happened|announced|released|launched))\b/i,
  /\b(?:20(?:2[3-9]|[3-9]\d)\b)/i, // years 2023+
  /\b(?:t20|odi|test\s+match|cricket|football|soccer|nba|nfl|f1|formula\s+1)\b/i,
  /\b(?:new\s+(?:iphone|galaxy|pixel|macbook|playstation|xbox|nvidia|amd|tesla))\b/i,
];

/** Factual lookup patterns — medicines, products, entities, documentation */
const FACTUAL_PATTERNS: readonly RegExp[] = [
  /\b(?:medicine|medication|drug|tablet|capsule|syrup|supplement|dosage|side\s+effects?|used\s+for|prescribed\s+for|treats?)\b/i,
  /\b(?:what\s+is|what\s+are|who\s+is|who\s+are|where\s+is|when\s+(?:was|did|is)|how\s+(?:does|do|did|is|was))\b.*\b[A-Z][a-zA-Z]{2,}/,
  /\b(?:product|specification|specs?|review|price\s+of|cost\s+of|features?\s+of)\b/i,
  /\b(?:documentation|api\s+(?:for|docs?)|library\s+(?:for|called)|framework\s+(?:for|called)|package\s+(?:for|called))\b/i,
  /\b(?:company|brand|manufacturer|founded|headquarter|ceo\s+of)\b/i,
  /\b(?:population\s+of|capital\s+of|gdp\s+of|area\s+of|currency\s+of)\b/i,
  /\b(?:release\s+date|launch\s+date|when\s+(?:was|is).*released)\b/i,
  /\b(?:ingredients?\s+(?:of|in)|composition\s+of|made\s+(?:of|from))\b/i,
  /\b(?:symptoms?\s+of|causes?\s+of|treatment\s+for|cure\s+for)\b/i,
  /\b(?:compare|comparison|difference\s+between|vs\.?\b|versus)\b/i,
];

/** Personal context patterns — refer to user's own data */
const PERSONAL_PATTERNS: readonly RegExp[] = [
  /\b(?:my\s+(?:name|age|email|phone|address|birthday|project|file|document|preference))\b/i,
  /\b(?:remember\s+(?:that|my|i)|forget\s+(?:that|my)|do\s+you\s+(?:know|remember)\s+(?:my|about\s+me))\b/i,
  /\b(?:i\s+(?:told\s+you|mentioned|said\s+(?:that|my))|you\s+(?:know|said)\s+(?:my|that\s+i))\b/i,
];

/** Image generation patterns */
const IMAGE_PATTERNS: readonly RegExp[] = [
  /\b(?:generate|create|draw|make|design|paint|sketch|render|illustrate)\s+(?:an?\s+)?(?:image|picture|photo|illustration|artwork|art|logo|icon|graphic|poster)/i,
  /\b(?:image|picture|photo|illustration)\s+of\b/i,
];

// ==============================
// Classifier
// ==============================

/**
 * Classify a user query deterministically using pattern matching.
 *
 * Runs in < 1ms with zero LLM cost.  The orchestrator uses this as
 * a safety net — if the LLM planner misclassifies, this overrides.
 */
export function classifyQueryType(query: string): QueryClassification {
  const trimmed = query.trim();
  if (!trimmed) {
    return { category: "general_knowledge", needsWebSearch: false, matchedRule: "empty" };
  }

  // 1. Image generation (highest priority — explicit user intent)
  for (const pat of IMAGE_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "image_generation", needsWebSearch: false, matchedRule: `image:${pat.source.slice(0, 40)}` };
    }
  }

  // 2. Personal context
  for (const pat of PERSONAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "personal_context", needsWebSearch: false, matchedRule: `personal:${pat.source.slice(0, 40)}` };
    }
  }

  // 3. Real-time information (needs web search)
  for (const pat of REALTIME_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "real_time_information", needsWebSearch: true, matchedRule: `realtime:${pat.source.slice(0, 40)}` };
    }
  }

  // 4. Factual lookup (needs web search)
  for (const pat of FACTUAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "factual_lookup", needsWebSearch: true, matchedRule: `factual:${pat.source.slice(0, 40)}` };
    }
  }

  // 5. Heuristic: questions about unknown/proper-noun entities
  //    "What is Tricium Joints?" — contains a capitalized multi-word entity
  //    that likely isn't in training data
  const unknownEntityMatch = trimmed.match(
    /(?:what\s+is|what\s+are|tell\s+me\s+about|explain|describe|define)\s+(.+?)[\?\.\!]?$/i,
  );
  if (unknownEntityMatch) {
    const subject = unknownEntityMatch[1].trim();
    // If the subject has words starting with uppercase beyond normal sentence start
    const words = subject.split(/\s+/);
    const capitalizedCount = words.filter(w => /^[A-Z]/.test(w)).length;
    if (capitalizedCount >= 1 && words.length <= 8) {
      return { category: "factual_lookup", needsWebSearch: true, matchedRule: "entity_heuristic" };
    }
  }

  // Default: general knowledge — LLM can answer from training data
  return { category: "general_knowledge", needsWebSearch: false, matchedRule: "default" };
}

/**
 * Build a web-search-optimized query from the user message.
 * Strips conversational filler and focuses on the factual question.
 */
export function buildSearchQuery(userMessage: string): string {
  // Remove conversational prefixes
  let q = userMessage
    .replace(/^(?:hey|hi|hello|please|can\s+you|could\s+you|i\s+want\s+to\s+know|tell\s+me|do\s+you\s+know)\s*/i, "")
    .replace(/[?.!]+$/, "")
    .trim();

  // If the cleaned query is too short, use the original
  if (q.length < 5) q = userMessage.trim();

  return q;
}
