// SentIQ Chat v2 — Tavily Search Pipeline
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
//   LLM Synthesis (Groq -> Gemini/Gemma web fallback chain)
//       ↓
//   Final Answer (with source references)
//
// Features:
//   - Parallel search execution for all expanded queries
//   - Intelligent result aggregation and ranking
//   - LLM synthesis for coherent answers
//   - Graceful fallback on total failure

import { TavilyProvider, isTavilyAvailable, getTavilyKeyStatus } from "./providers/tavilyProvider";
import { normalizeWebSearchMode, type WebSearchMode } from "./webSearchMode";
import { expandQuery } from "./queryExpander";
import { aggregateResults, formatResultsForLLM, extractSourceReferences } from "./resultsAggregator";
import { extractContent } from "./contentExtractor";
import type { SearchResult } from "./types";
import { callLLMAdapterDetailed } from "../../ai/PromptBuilders";

// ==============================
// Configuration
// ==============================

const MAX_RESULTS_PER_QUERY = 5;
const TOTAL_MAX_RESULTS = 8;
const MAX_CONTENT_EXTRACT = 5;

// ==============================
// Types
// ==============================

export interface TavilySearchRequest {
  query: string;
  maxResults?: number;
  skipLLMSynthesis?: boolean;
  webSearchMode?: WebSearchMode;
  signal?: AbortSignal;
}

export interface TavilySearchResponse {
  success: boolean;
  query: string;
  answer?: string;
  images?: string[];
  results: SearchResult[];
  sources: Array<{ title: string; url: string }>;
  queriesUsed: number;
  provider?: string;
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
- Format the answer in clean Markdown with short paragraphs
- Use short headings or bullet points only when they improve readability
- Do not dump raw snippets, repeated source titles, or long numbered lists of search results
- Do not include a "Sources" section; links will be appended separately
- Avoid echoing webpage chrome such as navigation labels, repeated headings, or stray "Title:" prefixes from extracted content

USER QUESTION: {query}

{context}

Provide your synthesized answer:`;

async function synthesizeWithLLM(
  query: string,
  context: string,
  signal?: AbortSignal,
): Promise<{ answer: string; success: boolean; error?: string }> {
  const prompt = SYNTHESIS_PROMPT
    .replace("{query}", query)
    .replace("{context}", context);

  try {
    const result = await callLLMAdapterDetailed({
      prompt,
      task: "web_search_synthesis",
      prefer: "groq",
      model_override: "gpt-oss-120b",
      user_id: "system",
      signal,
      timeout_ms: 60_000,
    });
    const answer = result.text;

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
  maxResultsPerQuery: number,
  mode: WebSearchMode,
  signal?: AbortSignal,
): Promise<ReadonlyArray<readonly SearchResult[]>> {
  console.log(`[TavilyPipeline] executing ${queries.length} parallel searches`);

  const searchPromises = queries.map(async (q) => {
    try {
      return await provider.search(q, maxResultsPerQuery, mode, signal);
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

  const normalizeSnippet = (value: string | undefined, maxChars = 220): string => {
    const rawLines = String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .replace(/^\s*#{1,6}\s*/gm, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(?:home|menu|latest|browse|videos?|news|watch now|skip to content)$/i.test(line))
      .map((line) => line.replace(/^(?:title|page title|summary title|web summary title|key findings?)\s*:\s*/i, ""));

    const cleaned = rawLines
      .join(" ")
      .replace(/\s*#{1,6}\s+/g, " ")
      .replace(/\b(?:title|page title|summary title|web summary title)\s*:\s*/gi, "")
      .replace(/\b(?:Web Summary|Key Findings|Sources)\s*:\s*/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!cleaned) return "";
    return cleaned.length > maxChars
      ? `${cleaned.slice(0, maxChars).trimEnd()}...`
      : cleaned;
  };

  const summaryLead =
    normalizeSnippet(results[0]?.snippet || results[0]?.body, 260) ||
    `I found several relevant sources about ${query}.`;

  const findings = results
    .slice(0, 3)
    .map((result) => {
      const title = (result.title || "Untitled source").trim();
      const snippet = normalizeSnippet(result.snippet || result.body, 200) || "Relevant reporting was found, but the preview text was limited.";
      return `- **${title}**: ${snippet}`;
    })
    .join("\n");

  return [
    "### Web Summary",
    summaryLead,
    "",
    "### Key Findings",
    findings,
    "",
    "_This summary was generated from search result previews because full synthesis was unavailable._",
  ].join("\n");
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
  const {
    query,
    maxResults = TOTAL_MAX_RESULTS,
    skipLLMSynthesis = false,
    webSearchMode,
    signal,
  } = request;
  const mode = normalizeWebSearchMode(webSearchMode);

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

  // Step 2: Execute primary query with metadata (answer/images)
  let primaryAnswer: string | undefined;
  let primaryImages: string[] = [];
  let primaryResults: SearchResult[] = [];

  try {
    const primary = await provider.searchWithMetadata(
      expanded.original,
      MAX_RESULTS_PER_QUERY,
      mode,
      signal,
    );
    primaryAnswer = primary.answer;
    primaryImages = primary.images;
    primaryResults = primary.results;
  } catch (err) {
    console.log(`[TavilyPipeline] primary query failed: ${err}`);
  }

  // Step 3: Execute parallel searches for variations
  const variationResults = await executeParallelSearches(
    expanded.variations,
    provider,
    MAX_RESULTS_PER_QUERY,
    mode,
    signal,
  );

  const resultSets = [primaryResults, ...variationResults];

  // Step 4: Aggregate results
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

  // Step 5: Extract content from top results
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

  // Step 6: Prepare context for LLM (fallback only)
  const context = formatResultsForLLM(enrichedResults);
  const sources = extractSourceReferences(enrichedResults);

  // Step 7: Prefer Tavily answer, fallback to LLM when missing
  let answer: string | undefined;
  if (primaryAnswer && primaryAnswer.trim()) {
    answer = primaryAnswer.trim();
  } else if (!skipLLMSynthesis) {
    const synthesis = await synthesizeWithLLM(query, context, signal);

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

  console.log(
    `[TavilyPipeline] pipeline complete: ${enrichedResults.length} results, ${expanded.all.length} queries used`
  );

  return {
    success: true,
    query,
    answer,
    images: primaryImages,
    results: enrichedResults,
    sources,
    queriesUsed: expanded.all.length,
    provider: "tavily",
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
  maxResults = 5,
  webSearchMode?: WebSearchMode,
): Promise<{ success: boolean; results: SearchResult[]; error?: string }> {
  if (!isTavilyAvailable()) {
    return {
      success: false,
      results: [],
      error: "Tavily API not configured",
    };
  }

  const provider = new TavilyProvider();
  const mode = normalizeWebSearchMode(webSearchMode);

  try {
    const results = await provider.search(query, maxResults, mode);
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
