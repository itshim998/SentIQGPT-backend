// SentIQGPT v2 — Results Aggregator
//
// Intelligently combines search results from multiple queries:
//   - Merges results from all expanded queries
//   - Removes duplicates (based on URL)
//   - Ranks results using Tavily score + relevance to original query
//   - Selects top N results (default: 8)
//
// Produces a deduplicated, ranked list of the most relevant results.

import type { SearchResult } from "./types";

// ==============================
// Configuration
// ==============================

const DEFAULT_MAX_RESULTS = 8;
const MIN_SNIPPET_LENGTH = 50;
const URL_NORMALIZATION_REGEX = /^(?:https?:\/\/)?(?:www\.)?(.+?)(?:\/)?$/i;

// ==============================
// Types
// ==============================

export interface AggregatedSearchResults {
  results: SearchResult[];
  totalBeforeDedup: number;
  uniqueCount: number;
  queriesUsed: number;
}

interface ScoredResult extends SearchResult {
  aggregateScore: number;
  queryMatchCount: number;
}

// ==============================
// URL Normalization
// ==============================

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove www, trailing slashes, query params, and fragments for comparison
    let normalized = parsed.hostname.replace(/^www\./i, "") + parsed.pathname;
    // Remove trailing slash
    normalized = normalized.replace(/\/$/, "");
    return normalized.toLowerCase();
  } catch {
    // Fallback: simple normalization
    const match = url.match(URL_NORMALIZATION_REGEX);
    return match ? match[1].toLowerCase() : url.toLowerCase();
  }
}

// ==============================
// Relevance Scoring
// ==============================

function extractKeywords(text: string): Set<string> {
  const stopwords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
    "for", "of", "with", "by", "from", "as", "is", "are", "was", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "can", "may", "might",
    "this", "that", "these", "those", "it", "its",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w));

  return new Set(words);
}

function calculateRelevanceScore(
  result: SearchResult,
  originalQuery: string
): number {
  const queryKeywords = extractKeywords(originalQuery);
  const titleKeywords = extractKeywords(result.title);
  const snippetKeywords = extractKeywords(result.snippet);

  // Calculate keyword overlap
  let titleMatches = 0;
  let snippetMatches = 0;

  for (const kw of queryKeywords) {
    if (titleKeywords.has(kw)) titleMatches++;
    if (snippetKeywords.has(kw)) snippetMatches++;
  }

  const querySize = queryKeywords.size || 1;

  // Title matches are weighted higher
  const titleScore = (titleMatches / querySize) * 0.6;
  const snippetScore = (snippetMatches / querySize) * 0.4;

  return Math.min(1, titleScore + snippetScore);
}

function calculateAggregateScore(
  result: SearchResult,
  originalQuery: string,
  queryMatchCount: number
): number {
  // Base score from Tavily (0-1)
  const tavilyScore = result.score ?? 0.5;

  // Relevance to original query (0-1)
  const relevanceScore = calculateRelevanceScore(result, originalQuery);

  // Bonus for appearing in multiple query results (0-0.3)
  const multiQueryBonus = Math.min(0.3, (queryMatchCount - 1) * 0.1);

  // Quality signals
  let qualityBonus = 0;

  // Prefer results with longer snippets (more content)
  if ((result.snippet?.length ?? 0) > 200) {
    qualityBonus += 0.05;
  }

  // Prefer results with extracted body text
  if (result.body && result.body.length > 100) {
    qualityBonus += 0.1;
  }

  // Weighted combination
  const aggregateScore =
    tavilyScore * 0.4 +
    relevanceScore * 0.4 +
    multiQueryBonus +
    qualityBonus;

  return Math.min(1, aggregateScore);
}

// ==============================
// Deduplication
// ==============================

function deduplicateResults(
  resultSets: ReadonlyArray<readonly SearchResult[]>,
  originalQuery: string
): ScoredResult[] {
  const urlMap = new Map<string, ScoredResult>();

  for (const results of resultSets) {
    for (const result of results) {
      const normalizedUrl = normalizeUrl(result.url);

      const existing = urlMap.get(normalizedUrl);
      if (existing) {
        // Increment query match count
        existing.queryMatchCount++;
        // Keep the better snippet/score
        if ((result.score ?? 0) > (existing.score ?? 0)) {
          urlMap.set(normalizedUrl, {
            ...result,
            aggregateScore: 0, // Will be recalculated
            queryMatchCount: existing.queryMatchCount,
          });
        }
      } else {
        urlMap.set(normalizedUrl, {
          ...result,
          aggregateScore: 0,
          queryMatchCount: 1,
        });
      }
    }
  }

  // Calculate aggregate scores
  const scoredResults: ScoredResult[] = [];
  for (const result of urlMap.values()) {
    result.aggregateScore = calculateAggregateScore(
      result,
      originalQuery,
      result.queryMatchCount
    );
    scoredResults.push(result);
  }

  return scoredResults;
}

// ==============================
// Main Aggregator
// ==============================

/**
 * Aggregate search results from multiple queries.
 *
 * @param resultSets - Array of result arrays from each query
 * @param originalQuery - The original user query (for relevance scoring)
 * @param maxResults - Maximum number of results to return (default: 8)
 */
export function aggregateResults(
  resultSets: ReadonlyArray<readonly SearchResult[]>,
  originalQuery: string,
  maxResults = DEFAULT_MAX_RESULTS
): AggregatedSearchResults {
  const totalBeforeDedup = resultSets.reduce((sum, r) => sum + r.length, 0);

  if (totalBeforeDedup === 0) {
    return {
      results: [],
      totalBeforeDedup: 0,
      uniqueCount: 0,
      queriesUsed: resultSets.length,
    };
  }

  // Deduplicate and score
  const scoredResults = deduplicateResults(resultSets, originalQuery);

  // Sort by aggregate score (descending)
  scoredResults.sort((a, b) => b.aggregateScore - a.aggregateScore);

  // Filter low-quality results
  const filteredResults = scoredResults.filter(
    (r) => r.aggregateScore >= 0.2 || r.queryMatchCount >= 2
  );

  // Take top N
  const topResults = filteredResults.slice(0, maxResults);

  // Remove internal scoring fields for output
  const cleanResults: SearchResult[] = topResults.map(
    ({ aggregateScore, queryMatchCount, ...rest }) => {
      void aggregateScore;
      void queryMatchCount;
      return rest;
    }
  );

  console.log(
    `[ResultsAggregator] ${totalBeforeDedup} total → ${scoredResults.length} unique → ${cleanResults.length} final`
  );

  return {
    results: cleanResults,
    totalBeforeDedup,
    uniqueCount: scoredResults.length,
    queriesUsed: resultSets.length,
  };
}

// ==============================
// Context Formatter
// ==============================

/**
 * Format aggregated results into clean context for LLM.
 *
 * Produces a structured, readable format without raw JSON.
 */
export function formatResultsForLLM(
  results: readonly SearchResult[],
  maxCharsPerResult = 400
): string {
  if (results.length === 0) {
    return "No search results found.";
  }

  const formattedResults = results.map((result, index) => {
    const title = result.title.slice(0, 100);
    const content = result.body?.slice(0, maxCharsPerResult) ||
      result.snippet?.slice(0, maxCharsPerResult) ||
      "No content available";

    return `[${index + 1}] ${title}
URL: ${result.url}
${content.trim()}`;
  });

  return `Web Search Results (${results.length} sources):\n\n${formattedResults.join("\n\n---\n\n")}`;
}

/**
 * Extract source references for citation in final answer.
 */
export function extractSourceReferences(
  results: readonly SearchResult[]
): Array<{ title: string; url: string }> {
  return results.map((r) => ({
    title: r.title.slice(0, 80),
    url: r.url,
  }));
}
