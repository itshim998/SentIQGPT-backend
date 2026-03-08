// SentIQGPT v2 — Memory Relevance Selector
//
// Scores each memory against the current user query using:
//   1. Keyword overlap  (50% weight)
//   2. Importance score  (30% weight)
//   3. Memory-type boost (20% weight)
//
// Returns the top-N most relevant memories for prompt injection,
// keeping token usage low while preserving personalization.

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

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function scoreMemory(memory: ScoredMemory, queryTokens: Set<string>): number {
  // 1. Keyword overlap
  const summaryLower = memory.summary.toLowerCase();
  let hits = 0;
  for (const word of queryTokens) {
    if (summaryLower.includes(word)) hits++;
  }
  const keywordScore = queryTokens.size > 0 ? hits / queryTokens.size : 0;

  // 2. Importance (normalize 1-10 → 0-1, default 5)
  const importance = (memory.importance ?? 5) / 10;

  // 3. Type boost
  const typeBoost = TYPE_BOOST[memory.type] ?? 0;

  // Combined: 50% keyword, 30% importance, 20% type
  return keywordScore * 0.5 + importance * 0.3 + typeBoost * 0.2;
}

// ==============================
// Public API
// ==============================

/**
 * Select the top `limit` memories most relevant to `query`.
 * If there are fewer than `limit`, returns all.
 */
export function selectMemoriesForQuery(
  memories: readonly ScoredMemory[],
  query: string,
  limit: number = 3,
): ScoredMemory[] {
  if (memories.length <= limit) return [...memories];

  const queryTokens = tokenize(query);

  const scored = memories.map((m) => ({
    memory: m,
    score: scoreMemory(m, queryTokens),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.memory);
}
