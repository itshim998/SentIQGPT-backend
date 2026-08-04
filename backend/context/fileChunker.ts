// SentIQ Chat v2 - File Chunking Utility
//
// Splits large extracted text into overlapping chunks for
// efficient context window usage. During conversation, only
// the most relevant chunks are injected instead of the entire file.

const DEFAULT_CHUNK_SIZE = 800;   // characters per chunk
const DEFAULT_OVERLAP = 100;      // overlap between chunks
const COMPARISON_EXCERPT_CHARS = 900;
const COMPARISON_TRIM_MARKER = "\n[... comparison excerpt shortened ...]\n";

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

function isComparisonQuery(query: string): boolean {
  return /\b(?:compare|comparison|contrast|difference|differences|between|across|versus|vs|common|each document|all files)\b/i.test(query);
}

function boundComparisonExcerpt(chunk: TextChunk): TextChunk {
  if (chunk.text.length <= COMPARISON_EXCERPT_CHARS) return chunk;
  const retained = Math.max(0, COMPARISON_EXCERPT_CHARS - COMPARISON_TRIM_MARKER.length);
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  return {
    ...chunk,
    text: chunk.text.slice(0, head).trimEnd()
      + COMPARISON_TRIM_MARKER
      + chunk.text.slice(chunk.text.length - tail).trimStart(),
  };
}

/**
 * Select the most relevant chunks for a given query.
 * Returns up to `maxChunks` chunks, sorted by relevance.
 *
 * Comparison queries receive bounded excerpts before the composer applies its
 * per-document round-robin ordering. This guarantees that one document cannot
 * consume the comparison budget before another document contributes evidence.
 */
export function selectRelevantChunks(
  allChunks: readonly TextChunk[],
  query: string,
  maxChunks: number = 5,
): TextChunk[] {
  const comparison = isComparisonQuery(query);
  if (allChunks.length <= maxChunks) {
    return comparison
      ? allChunks.map(boundComparisonExcerpt)
      : [...allChunks];
  }

  const scored = allChunks.map((chunk) => ({
    chunk,
    score: scoreChunkRelevance(chunk, query),
  }));

  scored.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
  const selected = scored.slice(0, maxChunks).map((item) => item.chunk);
  return comparison ? selected.map(boundComparisonExcerpt) : selected;
}
