// SentIQGPT v2 — DuckDuckGo Instant Answer API Provider
//
// Uses the free DuckDuckGo Instant Answer API.
// Returns structured results from the Abstract, Related Topics,
// and Infobox fields (no scraping required).
//
// API docs: https://api.duckduckgo.com/api

import type { WebSearchProvider, SearchResult } from "../types";

export class DuckDuckGoApiProvider implements WebSearchProvider {
  readonly name = "DuckDuckGo Instant";
  readonly source = "duckduckgo_api" as const;

  isAvailable(): boolean {
    return true; // Free, no key needed
  }

  async search(query: string, maxResults = 5): Promise<readonly SearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    const res = await fetch(url, {
      headers: { "User-Agent": "SentIQGPT/2.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`DuckDuckGo API ${res.status}`);

    const data = await res.json() as Record<string, unknown>;
    const results: SearchResult[] = [];

    // Abstract (main answer)
    if (typeof data.Abstract === "string" && data.Abstract) {
      results.push({
        title: typeof data.Heading === "string" ? data.Heading : query,
        url: typeof data.AbstractURL === "string" ? data.AbstractURL : "",
        snippet: data.Abstract.slice(0, 500),
        source: this.source,
      });
    }

    // Related Topics
    const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const topic of related) {
      if (results.length >= maxResults) break;

      const t = topic as Record<string, unknown>;
      if (typeof t.Text === "string" && typeof t.FirstURL === "string") {
        results.push({
          title: t.Text.slice(0, 120),
          url: t.FirstURL,
          snippet: t.Text.slice(0, 300),
          source: this.source,
        });
      }
    }

    if (results.length === 0) {
      throw new Error("No results from DuckDuckGo Instant API");
    }

    console.log(`[DDG-API] returned ${results.length} result(s) for "${query.slice(0, 50)}"`);
    return results;
  }
}
