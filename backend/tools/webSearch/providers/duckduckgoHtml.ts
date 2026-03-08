// SentIQGPT v2 — DuckDuckGo HTML Search Provider
//
// Fallback provider that fetches DuckDuckGo's lite HTML search page
// and extracts result links/snippets via simple text parsing.
//
// This is a lightweight scraper for the /lite/ endpoint which is
// designed for text-mode browsers and has a stable structure.
// No API key required.

import type { WebSearchProvider, SearchResult } from "../types";

export class DuckDuckGoHtmlProvider implements WebSearchProvider {
  readonly name = "DuckDuckGo HTML";
  readonly source = "duckduckgo_html" as const;

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, maxResults = 5): Promise<readonly SearchResult[]> {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "SentIQGPT/2.0 (text browser)",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`DuckDuckGo HTML ${res.status}`);

    const html = await res.text();
    return this.parseResults(html, maxResults);
  }

  private parseResults(html: string, max: number): SearchResult[] {
    const results: SearchResult[] = [];

    // The lite page has result links in <a class="result-link"> or plain <a> tags
    // after <td> cells. We extract href + text pairs.
    const linkPattern = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let match: RegExpExecArray | null;

    const seen = new Set<string>();

    while ((match = linkPattern.exec(html)) !== null) {
      if (results.length >= max) break;

      const href = match[1];
      const text = this.decodeEntities(match[2]).trim();

      // Skip DDG internal links and duplicates
      if (href.includes("duckduckgo.com") || seen.has(href) || !text) continue;
      seen.add(href);

      // Try to grab a snippet from the surrounding text
      const afterLink = html.slice(match.index + match[0].length, match.index + match[0].length + 400);
      const snippetMatch = afterLink.match(/<td[^>]*class="result-snippet"[^>]*>([^<]+)/i)
        ?? afterLink.match(/>([^<]{30,300})</);
      const snippet = snippetMatch
        ? this.decodeEntities(snippetMatch[1]).trim().slice(0, 300)
        : text;

      results.push({
        title: text.slice(0, 150),
        url: href,
        snippet,
        source: this.source,
      });
    }

    if (results.length === 0) {
      throw new Error("No results from DuckDuckGo HTML");
    }

    console.log(`[DDG-HTML] returned ${results.length} result(s)`);
    return results;
  }

  private decodeEntities(str: string): string {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'");
  }
}
