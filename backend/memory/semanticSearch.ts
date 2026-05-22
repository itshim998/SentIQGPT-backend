// SentIQGPT v2 — Semantic Memory Search
//
// Retrieves the most relevant memories for a user query using
// cosine similarity between vector embeddings.
//
// Pipeline:
//   1. Generate embedding for the user query
//   2. Compute cosine similarity against each memory's embedding
//   3. Return top-N memories sorted by similarity
//
// Falls back to the keyword-based memorySelector when embeddings
// are unavailable (e.g., older memories without vectors).

import { generateEmbedding } from "./memoryEmbedding";

// ==============================
// Types
// ==============================

export interface EmbeddedMemory {
  readonly type: string;
  readonly summary: string;
  readonly importance?: number;
  readonly embedding?: readonly number[];
}

export interface SemanticSearchResult {
  readonly memory: EmbeddedMemory;
  readonly similarity: number;
}

const DEFAULT_MIN_SIMILARITY = 0.72;

function readMinimumSimilarity(): number {
  const raw = process.env.MEMORY_SEMANTIC_MIN_SIMILARITY?.trim();
  if (!raw) return DEFAULT_MIN_SIMILARITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MIN_SIMILARITY;
  return Math.min(1, Math.max(0, parsed));
}

// ==============================
// Cosine Similarity
// ==============================

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function filterSemanticResultsByThreshold(
  results: readonly SemanticSearchResult[],
  minimumSimilarity = readMinimumSimilarity(),
): SemanticSearchResult[] {
  return results.filter((result) => result.similarity >= minimumSimilarity);
}

// ==============================
// Public API
// ==============================

/**
 * Search memories semantically using vector embeddings.
 *
 * @param memories - All available memories (some may lack embeddings)
 * @param query    - The user's current message
 * @param limit    - Maximum memories to return (default 3)
 * @returns Top-N memories ranked by cosine similarity, or `null`
 *          if embedding generation fails (caller should fall back
 *          to keyword search).
 */
export async function semanticMemorySearch(
  memories: readonly EmbeddedMemory[],
  query: string,
  limit: number = 3,
  minimumSimilarity = readMinimumSimilarity(),
): Promise<SemanticSearchResult[] | null> {
  // Only consider memories that actually have embeddings
  const embedded = memories.filter(
    (m): m is EmbeddedMemory & { embedding: readonly number[] } =>
      Array.isArray(m.embedding) && m.embedding.length > 0,
  );

  // If no memories have embeddings, signal caller to fall back
  if (embedded.length === 0) return null;

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) return null;

  console.log(`[MEMORY SEARCH] query embedding generated (${queryEmbedding.length} dims)`);

  // Score each embedded memory
  const scored: SemanticSearchResult[] = embedded.map((m) => {
    const sim = cosineSimilarity(queryEmbedding, m.embedding);
    return { memory: m, similarity: sim };
  });

  scored.sort((a, b) => b.similarity - a.similarity);

  const topN = filterSemanticResultsByThreshold(scored, minimumSimilarity).slice(0, limit);

  // Diagnostic logging
  for (const item of topN) {
    console.log(
      `[MEMORY SEARCH] similarity: ${item.similarity.toFixed(3)} | type: ${item.memory.type} | "${item.memory.summary.slice(0, 60)}"`,
    );
  }
  if (topN.length === 0) {
    console.log(`[MEMORY SEARCH] no memories met similarity threshold ${minimumSimilarity.toFixed(3)}`);
  }

  return topN;
}
