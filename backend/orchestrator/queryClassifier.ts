// SentIQGPT v2 — Deterministic Query Classifier
//
// Runs BEFORE the LLM planner to detect when web search is clearly
// required.  Uses keyword / pattern matching — zero LLM cost, < 1ms.
//
// Categories:
//   general_knowledge    — answerable from training data
//   real_time_information — current events, scores, news, live data
//   factual_lookup       — medicines, products, entities with dates
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

export type PersonalMemoryType = "identity" | "preference" | "project";

// ==============================
// No-search exclusion patterns
// ==============================
// These match FIRST and short-circuit to general_knowledge, preventing
// false-positive search triggers for trivial / knowledge-based queries.

const NO_SEARCH_PATTERNS: readonly RegExp[] = [
  // Basic definitions / explanations (no entity or date attached)
  /\b(?:what\s+is\s+(?:the\s+)?(?:current\s+)?(?:year|time|date|day))\b/i,
  /\b(?:explain|define|describe)\s+(?:the\s+)?(?:concept\s+of\s+)?(?:encapsulation|polymorphism|inheritance|abstraction|recursion|closure|hoisting|scope|prototype|class|interface|generics?|mutex|semaphore|deadlock|thread)/i,
  // Math / logic / calculations
  /\b(?:calculate|compute|solve|simplify|evaluate|what\s+is\s+\d)/i,
  /\b(?:factorial|fibonacci|prime|sqrt|square\s+root|logarithm|derivative|integral)\b/i,
  // Coding / programming questions
  /\b(?:write\s+(?:a\s+)?(?:code|program|function|script|class|method)|how\s+to\s+(?:code|implement|write)|fix\s+(?:this|my)\s+(?:code|bug|error))\b/i,
  /\b(?:syntax\s+(?:of|for|error)|compile|runtime\s+error|debug|refactor)\b/i,
  // General knowledge that doesn't need search
  /\b(?:how\s+(?:does|do)\s+(?:a\s+)?(?:computer|cpu|ram|cache|compiler|interpreter|operating\s+system|database|server|network|internet)\s+work)\b/i,
];

// ==============================
// Pattern banks
// ==============================

/** Time-sensitive / current-events patterns — require a real-world signal */
const REALTIME_PATTERNS: readonly RegExp[] = [
  // Current events — require an entity or topic alongside the time signal
  /\b(?:latest|recent)\s+(?:\w+\s+){0,3}(?:announcements?|news|updates?|releases?|launches?)\b/i,
  /\b(?:announcements?|news|updates?)\s+(?:from|on|about|by)\s+/i,
  /\b(?:who\s+won|who\s+is\s+winning|score\s+of|results?\s+of|standings?\s+of|live\s+score)\b/i,
  /\b(?:stock\s+price|share\s+price|market\s+cap|exchange\s+rate|bitcoin\s+price|crypto\s+price)\b/i,
  /\b(?:trending|viral)\s+\w+/i,
  /\b(?:just\s+(?:happened|announced|released|launched))\b/i,
  /\b(?:breaking\s+news)\b/i,
  // Sports events
  /\b(?:world\s+cup|ipl|olympics|super\s+bowl|grammy|oscar|emmy|grand\s+slam)\b/i,
  // Elections / politics with specificity
  /\b(?:election\s+results?|who\s+(?:is|was)\s+(?:elected|president|prime\s+minister))\b/i,
  // Product launches with brand names
  /\b(?:new\s+(?:iphone|galaxy|pixel|macbook|playstation|xbox))\b/i,
  // Weather requests (always real-time)
  /\b(?:weather\s+(?:in|for|today|forecast)|temperature\s+in)\b/i,
];

/** Year pattern: years >= 2026 paired with an entity or keyword */
const YEAR_WITH_ENTITY_RE = /\b(?:\w+\s+){0,5}(20(?:2[6-9]|[3-9]\d))\b/i;

/** Factual lookup — medicines, specific products, statistics */
const FACTUAL_PATTERNS: readonly RegExp[] = [
  /\b(?:medicine|medication|drug|tablet|capsule|syrup|supplement|dosage|side\s+effects?|prescribed\s+for)\b/i,
  /\b(?:symptoms?\s+of|causes?\s+of|treatment\s+for|cure\s+for)\b/i,
  /\b(?:price\s+of|cost\s+of|specs?\s+of|specifications?\s+of|features?\s+of)\b/i,
  /\b(?:statistics|stat)\s+(?:of|for|on|about)\b/i,
  /\b(?:population\s+of|gdp\s+of|capital\s+of)\b/i,
  /\b(?:release\s+date|launch\s+date)\s+(?:of|for)\b/i,
  /\b(?:ingredients?\s+(?:of|in)|composition\s+of)\b/i,
];

/** Personal context patterns — refer to user's own data */
const PERSONAL_PATTERNS: readonly RegExp[] = [
  /\b(?:my\s+(?:name|age|email|phone|address|birthday|project|file|document|preference))\b/i,
  /\b(?:remember\s+(?:that|my|i)|forget\s+(?:that|my)|do\s+you\s+(?:know|remember)\s+(?:my|about\s+me))\b/i,
  /\b(?:i\s+(?:told\s+you|mentioned|said\s+(?:that|my))|you\s+(?:know|said)\s+(?:my|that\s+i))\b/i,
];

/** Explicit memory write patterns — must be an actual save/store request. */
const EXPLICIT_MEMORY_WRITE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:please\s+)?remember\b/i,
  /\bcan\s+you\s+remember\s+(?:this|that|my|i)\b/i,
  /\bremember\s+this\b/i,
  /\bremember\s+that\b/i,
  /\bremember\s+my\b/i,
  /\bremember\s+i\b/i,
  /\b(?:save|store)\s+this\b/i,
  /\bkeep\s+this\s+in\s+mind\b/i,
];

const MEMORY_RETRIEVAL_PATTERNS: readonly RegExp[] = [
  /\bdo\s+you\s+remember\b/i,
  /\bwhat\s+do\s+you\s+remember\b/i,
  /\bwhat\s+is\s+my\b/i,
  /\bwho\s+am\s+i\b/i,
];

const IDENTITY_MEMORY_PATTERNS: readonly RegExp[] = [
  /\bmy\s+(?:name|age|email|phone|address|birthday)\b/i,
  /\bi\s+am\s+(?:called|named)\b/i,
];

const PREFERENCE_MEMORY_PATTERNS: readonly RegExp[] = [
  /\bmy\s+(?:favorite|favourite|preferred|preference)\b/i,
  /\bi\s+(?:prefer|like|love|dislike|hate)\b/i,
];

const PROJECT_MEMORY_PATTERNS: readonly RegExp[] = [
  /\bmy\s+project\b/i,
  /\bworking\s+on\b/i,
  /\bbuilding\b/i,
  /\bdeveloping\b/i,
  /\bportfolio\s+website\b/i,
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

  // 0. Image generation (highest priority — explicit user intent)
  for (const pat of IMAGE_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "image_generation", needsWebSearch: false, matchedRule: `image:${pat.source.slice(0, 40)}` };
    }
  }

  // 1. Personal context
  for (const pat of PERSONAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "personal_context", needsWebSearch: false, matchedRule: `personal:${pat.source.slice(0, 40)}` };
    }
  }

  // 2. No-search exclusions — catch trivial / knowledge queries early
  for (const pat of NO_SEARCH_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "general_knowledge", needsWebSearch: false, matchedRule: `no_search:${pat.source.slice(0, 40)}` };
    }
  }

  // 3. Real-time information (needs web search)
  for (const pat of REALTIME_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "real_time_information", needsWebSearch: true, matchedRule: `realtime:${pat.source.slice(0, 40)}` };
    }
  }

  // 3b. Year >= 2026 paired with at least one non-stopword entity
  if (YEAR_WITH_ENTITY_RE.test(trimmed)) {
    // Ensure there's a meaningful entity word besides the year
    const withoutYear = trimmed.replace(/\b20\d{2}\b/g, "").trim();
    const entityWords = withoutYear
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
    if (entityWords.length >= 1) {
      return { category: "real_time_information", needsWebSearch: true, matchedRule: "year_with_entity" };
    }
  }

  // 4. Factual lookup (needs web search)
  for (const pat of FACTUAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return { category: "factual_lookup", needsWebSearch: true, matchedRule: `factual:${pat.source.slice(0, 40)}` };
    }
  }

  // Default: general knowledge — LLM can answer from training data
  return { category: "general_knowledge", needsWebSearch: false, matchedRule: "default" };
}

export function detectExplicitMemoryWriteIntent(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (MEMORY_RETRIEVAL_PATTERNS.some((pat) => pat.test(trimmed))) return false;
  return EXPLICIT_MEMORY_WRITE_PATTERNS.some((pat) => pat.test(trimmed));
}

export function detectPersonalMemoryType(query: string): PersonalMemoryType | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  for (const pat of IDENTITY_MEMORY_PATTERNS) {
    if (pat.test(trimmed)) return "identity";
  }

  for (const pat of PREFERENCE_MEMORY_PATTERNS) {
    if (pat.test(trimmed)) return "preference";
  }

  for (const pat of PROJECT_MEMORY_PATTERNS) {
    if (pat.test(trimmed)) return "project";
  }

  return null;
}

// ==============================
// Fallback safeguard
// ==============================

/**
 * Safety-net check: should web search be forced even if the classifier
 * returned `needsWebSearch: false`?
 *
 * Only forces search when the query contains BOTH a year >= 2026 AND
 * a meaningful entity keyword — prevents triggering on "what year is it".
 */
export function shouldForceWebSearch(query: string): boolean {
  if (!YEAR_WITH_ENTITY_RE.test(query)) return false;
  const withoutYear = query.replace(/\b20\d{2}\b/g, "").trim();
  const entityWords = withoutYear
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
  return entityWords.length >= 1;
}

// ==============================
// Search query builder
// ==============================

/** Words to strip from search queries */
const STOPWORDS = new Set([
  "what", "which", "who", "whom", "where", "when", "why", "how",
  "is", "are", "was", "were", "be", "been", "being",
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "as", "into", "about",
  "that", "this", "these", "those", "it", "its",
  "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
  "has", "have", "had", "shall",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them",
  "tell", "explain", "list", "please", "give", "show", "describe",
  "latest", "major", "most", "some", "any", "very", "really", "just",
  "so", "far", "around", "currently", "right", "now",
]);

/**
 * Convert a natural-language user message into a concise search query.
 *
 * Steps:
 *   1. Strip punctuation.
 *   2. Tokenise on whitespace.
 *   3. Remove stopwords / filler.
 *   4. Keep 5–8 keyword tokens max.
 *
 * Examples:
 *   "What are the latest major announcements from NVIDIA in 2026 so far?"
 *   → "announcements nvidia 2026"
 *
 *   "Which are the most trending AI apps around the world?"
 *   → "trending ai apps world"
 */
export function buildSearchQuery(userMessage: string): string {
  // Strip punctuation
  const cleaned = userMessage.replace(/[?!.,;:'"()\[\]{}]/g, "");

  const tokens = cleaned
    .split(/\s+/)
    .filter(Boolean);

  const keywords: string[] = [];
  for (const token of tokens) {
    if (STOPWORDS.has(token.toLowerCase())) continue;
    keywords.push(token);
    if (keywords.length >= 8) break;
  }

  // If we stripped too aggressively, fall back to first 6 words
  if (keywords.length < 2) {
    return tokens.slice(0, 6).join(" ");
  }

  const query = keywords.join(" ");
  console.log(`[SearchQuery] generated: "${query}" (from: "${userMessage.slice(0, 60)}")`);
  return query;
}
