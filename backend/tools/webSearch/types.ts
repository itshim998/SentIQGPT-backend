// SentIQ Chat v2 — Web Search Types
//
// Shared interfaces for all search providers and the router.

/**
 * A single search result from any provider.
 */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Provider preview content (Tavily `content`). */
  readonly content?: string;
  /** Provider-provided images for this result (if available). */
  readonly images?: string[];
  /** Provider favicon URL for this result (if available). */
  readonly favicon?: string;
  /** Full extracted body text (populated by contentExtractor). */
  readonly body?: string;
  /** Which provider produced this result. */
  readonly source: SearchSource;
  /** Relevance score (0-1) from providers that support it (e.g., Tavily). */
  readonly score?: number;
  /** Provider-supplied publication time when it is reliable enough to retain. */
  readonly publishedAt?: string;
}

export type SearchSource = "duckduckgo_api" | "duckduckgo_html" | "wikipedia" | "tavily";

/**
 * Contract every search provider must satisfy.
 *
 * The router iterates providers in priority order, calling `search()`
 * on each until one returns results. A provider that cannot fulfil the
 * request should throw — the router catches and moves on.
 */
export interface WebSearchProvider {
  readonly name: string;
  readonly source: SearchSource;
  /** Returns true when the provider is usable (always true for free APIs). */
  isAvailable(): boolean;
  /** Perform a search. Throws on failure. */
  search(query: string, maxResults?: number): Promise<readonly SearchResult[]>;
}

/**
 * Final result returned by the web search router to the executor.
 */
export interface WebSearchResult {
  readonly success: boolean;
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly provider_used?: string;
  readonly error?: string;
}
