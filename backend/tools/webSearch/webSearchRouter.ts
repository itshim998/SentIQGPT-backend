// SentIQ Chat v2 — Web Search Router
//
// Sequential fallback router for web search providers.
// Tries each provider in priority order; returns as soon as one succeeds.
//
// Provider chain: Tavily (best) → DuckDuckGo HTML → DuckDuckGo Instant API → Wikipedia
//
// Tavily is prioritized because it:
//   - Returns structured results with relevance scores
//   - Supports multi-key rotation for high availability
//   - Provides high-quality, current web results
//
// DuckDuckGo HTML serves as fallback for real web search when Tavily is unavailable.
// The Instant API only exposes encyclopaedic abstracts and Wikipedia is limited to
// its own articles, so neither reliably surfaces recent or breaking-news content.
//
// After results are gathered, the content extractor enriches the top
// results with extracted body text from the source pages.

import type { WebSearchProvider, WebSearchResult, SearchResult } from "./types";
import { TavilyProvider, isTavilyAvailable } from "./providers/tavilyProvider";
import { DuckDuckGoApiProvider } from "./providers/duckduckgoApi";
import { DuckDuckGoHtmlProvider } from "./providers/duckduckgoHtml";
import { WikipediaProvider } from "./providers/wikipediaProvider";
import { extractContent } from "./contentExtractor";
import { getCachedSearchResults, setCachedSearchResults } from "../../cache/cacheManager";

// ==============================
// Provider registry (order = priority)
// ==============================

function buildProviderChain(): WebSearchProvider[] {
  const chain: WebSearchProvider[] = [];

  // Tavily is primary if configured
  if (isTavilyAvailable()) {
    chain.push(new TavilyProvider());
  }

  // Fallback chain
  chain.push(
    new DuckDuckGoHtmlProvider(),   // Real web search — best for current events
    new DuckDuckGoApiProvider(),    // Instant Answer (encyclopaedic)
    new WikipediaProvider(),        // Wikipedia articles (last resort)
  );

  return chain;
}

// Build provider chain once at startup, refresh on each call for dynamic key availability
const getProviders = (): readonly WebSearchProvider[] => buildProviderChain();

// Only extract body text for the top N results to limit latency
const MAX_EXTRACT = 3;

// ==============================
// Router
// ==============================

/**
 * Route a web search request through the provider chain.
 *
 * Iterates providers in priority order. For each:
 *   1. Check `isAvailable()` — skip if not usable.
 *   2. Call `search()` — return on success, catch and continue on failure.
 *
 * After getting results, enriches the top few with extracted body text.
 */
export async function routeWebSearch(args: {
  readonly query: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
  readonly skipTavily?: boolean;
  readonly skipCache?: boolean;
}): Promise<WebSearchResult> {
  const query = args.query.trim();
  if (!query) {
    return { success: false, query: args.query, results: [], error: "Query is required" };
  }
  args.signal?.throwIfAborted();

  // Check web search cache first
  if (!args.skipCache) {
    const cached = getCachedSearchResults(query);
    if (cached) {
      return { ...cached, success: true };
    }
  }

  const maxResults = args.maxResults ?? 5;
  const errors: string[] = [];
  console.log(`[WEB SEARCH] routing query: "${query.slice(0, 60)}..."`);

  // Get fresh provider chain (respects current key availability)
  const providers = args.skipTavily
    ? getProviders().filter((provider) => !(provider instanceof TavilyProvider))
    : getProviders();

  let rawResults: readonly SearchResult[] = [];
  let providerUsed: string | undefined;

  for (const provider of providers) {
    args.signal?.throwIfAborted();
    if (!provider.isAvailable()) {
      console.log(`[WEB SEARCH] skipping ${provider.name}: not available`);
      errors.push(`${provider.name}: not available`);
      continue;
    }

    try {
      console.log(`[WEB SEARCH] trying provider: ${provider.name}`);
      rawResults = provider instanceof TavilyProvider
        ? await provider.search(query, maxResults, "basic", args.signal, { includeAnswer: false })
        : await (provider.search as (
            query: string,
            maxResults?: number,
            signal?: AbortSignal,
          ) => Promise<readonly SearchResult[]>)(query, maxResults, args.signal);
      providerUsed = provider.name;
      console.log(`[WEB SEARCH] provider ${provider.name} — ${rawResults.length} result(s)`);
      break;
    } catch (err) {
      if (args.signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[WEB SEARCH] provider ${provider.name} failed: ${message}`);
      errors.push(`${provider.name}: ${message}`);
    }
  }

  if (rawResults.length === 0) {
    return {
      success: false,
      query,
      results: [],
      error: `All search providers failed. ${errors.join(" | ")}`,
    };
  }

  // Enrich top results with extracted page content
  let enriched: readonly SearchResult[];
  try {
    enriched = await extractContent(
      rawResults.slice(0, MAX_EXTRACT),
      1500,
      args.signal,
    );
    // Append remaining un-extracted results
    if (rawResults.length > MAX_EXTRACT) {
      enriched = [...enriched, ...rawResults.slice(MAX_EXTRACT)];
    }
  } catch {
    enriched = rawResults;
  }

  console.log(`[WEB SEARCH] returning ${enriched.length} result(s) via ${providerUsed}`);

  const finalResult: WebSearchResult = {
    success: true,
    query,
    results: enriched,
    provider_used: providerUsed,
  };

  // Store in cache for future identical queries
  if (!args.skipCache) setCachedSearchResults(query, finalResult);

  return finalResult;
}
