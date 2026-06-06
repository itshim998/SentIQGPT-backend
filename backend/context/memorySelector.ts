// SentIQ Chat v2 — Memory Relevance Selector
//
// Scores each memory against the current user query using:
//   1. Keyword overlap  (50% weight)
//   2. Importance score (30% weight)
//   3. Memory-type boost (20% weight)
//
// Only memories with an actual keyword hit or an explicit personal-memory
// lookup trigger are eligible for prompt injection.

// ==============================
// Types
// ==============================

export interface ScoredMemory {
  readonly type: string;
  readonly summary: string;
  readonly importance?: number;
}

// ==============================
// Scoring
// ==============================

/** Stop-words excluded from keyword matching to avoid false positives. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can",
  "had", "her", "was", "one", "our", "out", "has", "its", "let",
  "how", "what", "when", "who", "why", "this", "that", "with",
  "from", "they", "been", "have", "will", "would", "could", "should",
  "about", "which", "there", "their", "some", "than", "into",
]);

const TYPE_BOOST: Record<string, number> = {
  identity: 0.15,
  preference: 0.10,
  project: 0.05,
  knowledge: 0.0,
};

const EXPLICIT_TYPE_PATTERNS: Record<string, readonly RegExp[]> = {
  identity: [
    /\bmy\s+name\b/i,
    /\bwho\s+am\s+i\b/i,
    /\bmy\s+age\b/i,
    /\bmy\s+email\b/i,
    /\bmy\s+phone\b/i,
    /\bmy\s+address\b/i,
    /\bmy\s+birthday\b/i,
  ],
  preference: [
    /\bmy\s+preference\b/i,
    /\bwhat\s+do\s+i\s+like\b/i,
    /\bwhat\s+do\s+i\s+prefer\b/i,
  ],
  project: [
    /\bmy\s+project\b/i,
    /\bmy\s+(?:app|assistant|chatbot)\b/i,
    /\bworking\s+on\b/i,
    /\bbuilding\b/i,
    /\bdo\s+you\s+remember\b/i,
  ],
};

function expandMemorySearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bchatbot(s)?\b/g, "chatbot chat bot assistant")
    .replace(/\bchat[\s-]?assistant(s)?\b/g, "chat assistant chatbot bot")
    .replace(/\bai\s+assistant(s)?\b/g, "ai assistant chatbot")
    .replace(/\bproject(s)?\b/g, "project app build work");
}

function tokenize(text: string): Set<string> {
  return new Set(
    expandMemorySearchText(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function countKeywordHits(summaryLower: string, queryTokens: Set<string>): number {
  let hits = 0;
  const expandedSummary = expandMemorySearchText(summaryLower);
  for (const word of queryTokens) {
    if (expandedSummary.includes(word)) hits++;
  }
  return hits;
}

function hasExplicitTypeMatch(memoryType: string, query: string): boolean {
  const patterns = EXPLICIT_TYPE_PATTERNS[memoryType] ?? [];
  return patterns.some((pattern) => pattern.test(query));
}

function scoreMemory(
  memory: ScoredMemory,
  queryTokens: Set<string>,
  query: string,
): {
  readonly score: number;
  readonly keywordHits: number;
  readonly explicitTypeMatch: boolean;
} {
  const summaryLower = memory.summary.toLowerCase();
  const keywordHits = countKeywordHits(summaryLower, queryTokens);
  const explicitTypeMatch = hasExplicitTypeMatch(memory.type, query);
  const keywordScore = queryTokens.size > 0 ? keywordHits / queryTokens.size : 0;
  const importance = (memory.importance ?? 5) / 10;
  const typeBoost = TYPE_BOOST[memory.type] ?? 0;

  return {
    score:
      keywordScore * 0.5 +
      importance * 0.3 +
      typeBoost * 0.2 +
      (explicitTypeMatch ? 0.35 : 0),
    keywordHits,
    explicitTypeMatch,
  };
}

function isExplicitMemoryRecallQuery(query: string): boolean {
  return /\b(?:do\s+you\s+remember|what\s+do\s+you\s+remember|remember\s+(?:my|that|the)|what\s+do\s+you\s+know\s+about\s+me|about\s+my)\b/i.test(query);
}

// ==============================
// Public API
// ==============================

/**
 * Select the top `limit` memories most relevant to `query`.
 */
export function selectMemoriesForQuery(
  memories: readonly ScoredMemory[],
  query: string,
  limit: number = 3,
): ScoredMemory[] {
  const queryTokens = tokenize(query);
  const explicitRecall = isExplicitMemoryRecallQuery(query);

  const scored = memories
    .map((memory) => ({
      memory,
      ...scoreMemory(memory, queryTokens, query),
    }))
    .filter((item) => (
      item.keywordHits > 0
      || item.explicitTypeMatch
      || (
        explicitRecall
        && (item.memory.importance ?? 5) >= 7
        && ["identity", "preference", "project"].includes(item.memory.type)
      )
    ));

  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((item) => item.memory);
}
