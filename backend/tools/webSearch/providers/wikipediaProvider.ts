// SentIQ Chat v2 — Wikipedia Search Provider
//
// Uses the free Wikipedia REST API to fetch article summaries
// and search results. Two strategies:
//   1. Page summary (exact title match) — fastest, richest
//   2. Search endpoint (fuzzy query) — finds relevant articles
//
// API docs: https://en.wikipedia.org/api/rest_v1/

import type { WebSearchProvider, SearchResult } from "../types";
import { SERVICE_USER_AGENT } from "../../../branding";

interface WikiSearchHit {
  title: string;
  excerpt: string;
  key: string;
}

export class WikipediaProvider implements WebSearchProvider {
  readonly name = "Wikipedia";
  readonly source = "wikipedia" as const;

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, maxResults = 3): Promise<readonly SearchResult[]> {
    // Strategy 1: Try the search endpoint for broad coverage
    const searchUrl = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${maxResults}`;

    const res = await fetch(searchUrl, {
      headers: { "User-Agent": SERVICE_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`Wikipedia search API ${res.status}`);

    const data = await res.json() as { pages?: WikiSearchHit[] };
    const pages = Array.isArray(data.pages) ? data.pages : [];

    if (pages.length === 0) {
      throw new Error("No Wikipedia results");
    }

    // For each hit, fetch the summary to get a good snippet
    const results: SearchResult[] = [];

    for (const page of pages.slice(0, maxResults)) {
      try {
        const summary = await this.fetchSummary(page.key);
        results.push(summary);
      } catch {
        // Fall back to search excerpt
        results.push({
          title: page.title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
          snippet: this.stripHtml(page.excerpt).slice(0, 400),
          source: this.source,
        });
      }
    }

    console.log(`[WIKIPEDIA] returned ${results.length} result(s) for "${query.slice(0, 50)}"`);
    return results;
  }

  private async fetchSummary(titleKey: string): Promise<SearchResult> {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titleKey)}`;

    const res = await fetch(url, {
      headers: { "User-Agent": SERVICE_USER_AGENT },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) throw new Error(`Wikipedia summary ${res.status}`);

    const data = await res.json() as Record<string, unknown>;

    return {
      title: typeof data.title === "string" ? data.title : titleKey,
      url: typeof data.content_urls === "object" && data.content_urls !== null
        ? ((data.content_urls as Record<string, Record<string, string>>).desktop?.page ??
           `https://en.wikipedia.org/wiki/${encodeURIComponent(titleKey)}`)
        : `https://en.wikipedia.org/wiki/${encodeURIComponent(titleKey)}`,
      snippet: typeof data.extract === "string" ? data.extract.slice(0, 600) : "",
      source: this.source,
    };
  }

  private stripHtml(str: string): string {
    return str.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim();
  }
}
