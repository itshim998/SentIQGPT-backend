// SentIQGPT v2 — Memory Embedding Generator
//
// Generates vector embeddings for memory summaries and user queries
// so the system can retrieve semantically relevant memories even when
// the user uses completely different wording.
//
// Primary model:  Gemini embedding model configured by the Python LLM service
// Invoked via:    POST /llm/embed on the Python LLM service
//
// Embeddings are generated:
//   1. At memory-creation time (attached to the stored memory object)
//   2. At query time (to compare against stored embeddings)

import { getCachedEmbedding, setCachedEmbedding } from "../cache/cacheManager";

const LLM_SERVICE_URL =
  process.env.LLM_SERVICE_URL ||
  `http://localhost:${process.env.LLM_SERVICE_PORT || "3002"}`;

/**
 * Generate a vector embedding for a piece of text.
 * Returns a float array, or `undefined` on failure.
 * Checks the embedding cache first to avoid redundant API calls.
 */
export async function generateEmbedding(
  text: string,
): Promise<number[] | undefined> {
  if (!text.trim()) return undefined;

  // Check embedding cache first
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  try {
    const response = await fetch(`${LLM_SERVICE_URL}/llm/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.log(`[EMBEDDING] service error: ${response.status}`);
      return undefined;
    }

    const data = (await response.json()) as { embedding?: number[]; skipped?: boolean; reason?: string };

    if (data.skipped) {
      console.log(`[EMBEDDING] skipped by service (${data.reason ?? "unavailable"})`);
      return undefined;
    }

    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      console.log(`[EMBEDDING] invalid response shape`);
      return undefined;
    }

    // Store in cache for future lookups
    setCachedEmbedding(text, data.embedding);

    return data.embedding;
  } catch (err) {
    console.log(
      `[EMBEDDING] generation failed: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}
