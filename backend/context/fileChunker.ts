// SentIQGPT v2 - File Chunking Utility
//
// Splits large extracted text into overlapping chunks for
// efficient context window usage. During conversation, only
// the most relevant chunks are injected instead of the entire file.

const DEFAULT_CHUNK_SIZE = 800;   // characters per chunk
const DEFAULT_OVERLAP = 100;      // overlap between chunks

export interface TextChunk {
  readonly index: number;
  readonly text: string;
  readonly filename: string;
}

/**
 * Split text into overlapping chunks.
 * Tries to break at sentence boundaries when possible.
 */
export function chunkText(
  text: string,
  filename: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_OVERLAP,
): TextChunk[] {
  const safeChunkSize = Number.isFinite(chunkSize) && chunkSize > 0
    ? Math.floor(chunkSize)
    : DEFAULT_CHUNK_SIZE;
  const safeOverlap = Number.isFinite(overlap) && overlap > 0
    ? Math.min(Math.floor(overlap), safeChunkSize - 1)
    : 0;

  if (!text || text.length <= safeChunkSize) {
    return [{ index: 0, text, filename }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let idx = 0;

  while (start < text.length) {
    let end = Math.min(start + safeChunkSize, text.length);

    // Try to break at a sentence boundary (. ! ? \n)
    if (end < text.length) {
      const searchStart = Math.max(start, end - Math.min(100, safeChunkSize));
      const searchRegion = text.slice(searchStart, end);
      const lastSentence = searchRegion.search(/[.!?\n][^.!?\n]*$/);
      if (lastSentence > 0) {
        end = searchStart + lastSentence + 1;
      }
    }

    chunks.push({
      index: idx++,
      text: text.slice(start, end).trim(),
      filename,
    });

    const nextStart = end - safeOverlap;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

/**
 * Score how relevant a chunk is to a user query.
 * Uses simple keyword overlap - fast, no LLM needed.
 */
export function scoreChunkRelevance(chunk: TextChunk, query: string): number {
  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
  );
  const chunkLower = chunk.text.toLowerCase();
  let hits = 0;

  for (const word of queryWords) {
    if (chunkLower.includes(word)) hits++;
  }

  return queryWords.size > 0 ? hits / queryWords.size : 0;
}

/**
 * Select the most relevant chunks for a given query.
 * Returns up to `maxChunks` chunks, sorted by relevance.
 */
export function selectRelevantChunks(
  allChunks: readonly TextChunk[],
  query: string,
  maxChunks: number = 5,
): TextChunk[] {
  if (allChunks.length <= maxChunks) return [...allChunks];

  const scored = allChunks.map((chunk) => ({
    chunk,
    score: scoreChunkRelevance(chunk, query),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxChunks).map((s) => s.chunk);
}
