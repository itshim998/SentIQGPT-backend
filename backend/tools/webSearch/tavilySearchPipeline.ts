// SentIQGPT v2 — Tavily Search Pipeline
//
// Full web search pipeline that behaves like a research system:
//
//   User Query
//       ↓
//   Query Expander (3-5 variations)
//       ↓
//   Tavily Router (multi-key, parallel execution)
//       ↓
//   Results Aggregator (dedupe, rank, top N)
//       ↓
//   Content Preparation (clean context)
//       ↓
//   LLM Synthesis (gemini-fast)
//       ↓
//   Final Answer (with source references)
//
// Features:
//   - Parallel search execution for all expanded queries
//   - Intelligent result aggregation and ranking
//   - LLM synthesis for coherent answers
//   - Graceful fallback on total failure

import { TavilyProvider, isTavilyAvailable, getTavilyKeyStatus } from "./providers/tavilyProvider";
import { expandQuery } from "./queryExpander";
import { aggregateResults, formatResultsForLLM, extractSourceReferences } from "./resultsAggregator";
import { extractContent } from "./contentExtractor";
import type { SearchResult } from "./types";

// ==============================
// Configuration
// ==============================

const MAX_RESULTS_PER_QUERY = 5;
const TOTAL_MAX_RESULTS = 8;
const MAX_CONTENT_EXTRACT = 5;
const LLM_SERVICE_URL = process.env.LLM_SERVICE_URL ?? "http://127.0.0.1:3002";

// ==============================
// Types
// ==============================

export interface TavilySearchRequest {
  query: string;
  maxResults?: number;
  skipLLMSynthesis?: boolean;
}

export interface TavilySearchResponse {
  success: boolean;
  query: string;
  answer?: string;
  results: SearchResult[];
  sources: Array<{ title: string; url: string }>;
  queriesUsed: number;
  error?: string;
}

// ==============================
// LLM Synthesis
// ==============================

const SYNTHESIS_PROMPT = `You are a research assistant synthesizing web search results into a comprehensive answer.

TASK: Based on the search results below, provide a clear, accurate, and well-organized answer to the user's question.

GUIDELINES:
- Synthesize information from multiple sources into a coherent response
- Do NOT simply copy-paste from sources — create an original synthesis
- Include specific facts, figures, and details when available
- If sources disagree, acknowledge the different perspectives
- If information is unclear or incomplete, say so
- Keep the answer focused and relevant to the question
- Use natural, conversational language

USER QUESTION: {query}

{context}

Provide your synthesized answer:`;

async function synthesizeWithLLM(
  query: string,
  context: string
): Promise<{ answer: string; success: boolean; error?: string }> {
  const prompt = SYNTHESIS_PROMPT
    .replace("{query}", query)
    .replace("{context}", context);

  try {
    const response = await fetch(`${LLM_SERVICE_URL}/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        task: "web_search_synthesis",
        model_override: "gemini-fast",
        user_id: "system",
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.log(`[TavilyPipeline] LLM synthesis failed: HTTP ${response.status} - ${errorText}`);
      return {
        answer: "",
        success: false,
        error: `LLM service error: ${response.status}`,
      };
    }

    const data = await response.json() as { response?: string; text?: string };
    const answer = data.response ?? data.text ?? "";

    if (!answer || answer.trim().length < 10) {
      return {
        answer: "",
        success: false,
        error: "LLM returned empty response",
      };
    }

    return { answer: answer.trim(), success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[TavilyPipeline] LLM synthesis error: ${message}`);
    return {
      answer: "",
      success: false,
      error: message,
    };
  }
}

// ==============================
// Parallel Search Execution
// ==============================

async function executeParallelSearches(
  queries: string[],
  provider: TavilyProvider,
  maxResultsPerQuery: number
): Promise<ReadonlyArray<readonly SearchResult[]>> {
  console.log(`[TavilyPipeline] executing ${queries.length} parallel searches`);

  const searchPromises = queries.map(async (q) => {
    try {
      return await provider.search(q, maxResultsPerQuery);
    } catch (err) {
      console.log(`[TavilyPipeline] search failed for "${q.slice(0, 40)}...": ${err}`);
      return [] as readonly SearchResult[];
    }
  });

  const results = await Promise.all(searchPromises);
  const successfulCount = results.filter((r) => r.length > 0).length;

  console.log(
    `[TavilyPipeline] parallel search complete: ${successfulCount}/${queries.length} succeeded`
  );

  return results;
}

// ==============================
// Fallback Answer Generator
// ==============================

function generateFallbackAnswer(
  results: SearchResult[],
  query: string
): string {
  if (results.length === 0) {
    return "I couldn't find relevant information from web search. The search service may be temporarily unavailable.";
  }

  // Generate a simple answer from snippets without LLM
  const snippets = results
    .slice(0, 3)
    .map((r, i) => `${i + 1}. **${r.title}**: ${r.snippet?.slice(0, 200) ?? ""}`)
    .join("\n\n");

  return `Here's what I found about "${query}":\n\n${snippets}\n\n*Note: This is a simplified summary. Full synthesis was not available.*`;
}

// ==============================
// Main Pipeline
// ==============================

/**
 * Execute the full Tavily search pipeline.
 *
 * Pipeline:
 *   1. Expand query into 3-5 variations
 *   2. Execute parallel Tavily searches
 *   3. Aggregate and rank results
 *   4. Extract content from top results
 *   5. Synthesize answer with LLM
 */
export async function executeTavilySearchPipeline(
  request: TavilySearchRequest
): Promise<TavilySearchResponse> {
  const { query, maxResults = TOTAL_MAX_RESULTS, skipLLMSynthesis = false } = request;

  console.log(`[TavilyPipeline] starting pipeline for: "${query.slice(0, 60)}..."`);

  // Check if Tavily is available
  if (!isTavilyAvailable()) {
    const status = getTavilyKeyStatus();
    console.log(`[TavilyPipeline] Tavily not available: ${status.available}/${status.total} keys`);
    return {
      success: false,
      query,
      results: [],
      sources: [],
      queriesUsed: 0,
      error: "Tavily API is not configured. Please add TAVILY_KEYS to your environment.",
    };
  }

  const provider = new TavilyProvider();

  // Step 1: Expand query
  const expanded = expandQuery(query);
  console.log(`[TavilyPipeline] expanded to ${expanded.all.length} queries`);

  // Step 2: Execute parallel searches
  const resultSets = await executeParallelSearches(
    expanded.all,
    provider,
    MAX_RESULTS_PER_QUERY
  );

  // Step 3: Aggregate results
  const aggregated = aggregateResults(resultSets, expanded.original, maxResults);

  if (aggregated.results.length === 0) {
    return {
      success: false,
      query,
      results: [],
      sources: [],
      queriesUsed: expanded.all.length,
      error: "No results found from any search query.",
    };
  }

  // Step 4: Extract content from top results
  let enrichedResults: SearchResult[];
  try {
    enrichedResults = await extractContent(
      aggregated.results.slice(0, MAX_CONTENT_EXTRACT),
      1200 // Max chars per page
    );
    // Append remaining results without enrichment
    if (aggregated.results.length > MAX_CONTENT_EXTRACT) {
      enrichedResults = [
        ...enrichedResults,
        ...aggregated.results.slice(MAX_CONTENT_EXTRACT),
      ];
    }
  } catch (err) {
    console.log(`[TavilyPipeline] content extraction failed: ${err}`);
    enrichedResults = aggregated.results;
  }

  // Step 5: Prepare context for LLM
  const context = formatResultsForLLM(enrichedResults);
  const sources = extractSourceReferences(enrichedResults);

  // Step 6: Synthesize with LLM (unless skipped)
  let answer: string | undefined;

  if (!skipLLMSynthesis) {
    const synthesis = await synthesizeWithLLM(query, context);

    if (synthesis.success) {
      answer = synthesis.answer;
    } else {
      console.log(`[TavilyPipeline] LLM synthesis failed, using fallback`);
      answer = generateFallbackAnswer(enrichedResults, query);
    }
  } else {
    // If LLM synthesis is skipped, just format raw results
    answer = generateFallbackAnswer(enrichedResults, query);
  }

  // Append source references to answer
  if (answer && sources.length > 0) {
    const sourceList = sources
      .slice(0, 5)
      .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
      .join("\n");
    answer = `${answer}\n\n**Sources:**\n${sourceList}`;
  }

  console.log(
    `[TavilyPipeline] pipeline complete: ${enrichedResults.length} results, ${expanded.all.length} queries used`
  );

  return {
    success: true,
    query,
    answer,
    results: enrichedResults,
    sources,
    queriesUsed: expanded.all.length,
  };
}

// ==============================
// Simple Search (No Pipeline)
// ==============================

/**
 * Simple single-query Tavily search without expansion or synthesis.
 * Use this for direct API access when the full pipeline isn't needed.
 */
export async function searchTavily(
  query: string,
  maxResults = 5
): Promise<{ success: boolean; results: SearchResult[]; error?: string }> {
  if (!isTavilyAvailable()) {
    return {
      success: false,
      results: [],
      error: "Tavily API not configured",
    };
  }

  const provider = new TavilyProvider();

  try {
    const results = await provider.search(query, maxResults);
    return { success: true, results: [...results] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, results: [], error: message };
  }
}

// ==============================
// Health Check
// ==============================

/**
 * Check Tavily pipeline health status.
 */
export function getTavilyPipelineStatus(): {
  available: boolean;
  keyStatus: { total: number; available: number };
} {
  const keyStatus = getTavilyKeyStatus();
  return {
    available: isTavilyAvailable(),
    keyStatus,
  };
}
