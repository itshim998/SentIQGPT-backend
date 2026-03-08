// SentIQGPT v2 — Content Extractor
//
// Lightweight HTML-to-text extraction for web search results.
// Fetches a URL and strips scripts, styles, nav, ads, and other
// non-content elements to produce clean body text.
//
// Character limit: ~1500 per page to stay within LLM context budgets.

import type { SearchResult } from "./types";

const MAX_BODY_CHARS = 1500;
const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch and extract clean body text for each search result.
 * Results that fail to fetch are left without a body — not fatal.
 */
export async function extractContent(
  results: readonly SearchResult[],
  maxPerPage = MAX_BODY_CHARS,
): Promise<SearchResult[]> {
  const enriched: SearchResult[] = [];

  for (const result of results) {
    // Skip if already has body or no URL
    if (result.body || !result.url) {
      enriched.push({ ...result });
      continue;
    }

    try {
      const body = await fetchAndExtract(result.url, maxPerPage);
      enriched.push({ ...result, body });
    } catch {
      // Keep result as-is (snippet only)
      enriched.push({ ...result });
    }
  }

  return enriched;
}

async function fetchAndExtract(url: string, maxChars: number): Promise<string> {
  // SSRF protection: only allow http(s) and block private/internal hosts
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("172.") ||
    host.endsWith(".local") ||
    host === "[::1]" ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Private/internal URLs are blocked");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": "SentIQGPT/2.0 (content extractor)",
      "Accept": "text/html",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const html = await res.text();
  return htmlToText(html, maxChars);
}

/**
 * Strip HTML to plain text, removing non-content elements.
 */
function htmlToText(html: string, maxChars: number): string {
  let text = html;

  // Remove script, style, nav, footer, header, aside blocks
  text = text.replace(/<(script|style|nav|footer|header|aside|noscript|svg|form)[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)));

  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text.slice(0, maxChars);
}
