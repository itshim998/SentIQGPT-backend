// SentIQ Chat v2 — Content Extractor
//
// Lightweight HTML-to-text extraction for web search results.
// Fetches a URL and strips scripts, styles, nav, ads, and other
// non-content elements to produce clean body text.
//
// Character limit: ~1500 per page to stay within LLM context budgets.

import type { SearchResult } from "./types";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SERVICE_USER_AGENT } from "../../branding";

const MAX_BODY_CHARS = 1500;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

type DnsResolver = (hostname: string) => Promise<readonly { address: string }[]>;

const DEFAULT_DNS_RESOLVER: DnsResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => ({ address }));
};

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

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function parseIpv4(address: string): number[] | null {
  const match = address.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!match) return null;
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

export function isPrivateOrInternalAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipv4Mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const ipv4 = parseIpv4(ipv4Mapped?.[1] ?? normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (isIP(normalized) !== 6) return false;
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}

export function isPrivateOrInternalHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal" ||
    isPrivateOrInternalAddress(host)
  );
}

async function assertPublicHttpUrl(url: string, resolver: DnsResolver = DEFAULT_DNS_RESOLVER): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }

  const host = normalizeHostname(parsed.hostname);
  if (isPrivateOrInternalHost(host)) {
    throw new Error("Private/internal URLs are blocked");
  }

  if (isIP(host) === 0) {
    const addresses = await resolver(host);
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrInternalAddress(address))) {
      throw new Error("Private/internal URLs are blocked");
    }
  }

  return parsed;
}

async function fetchValidated(url: string, redirectCount = 0): Promise<Response> {
  const parsed = await assertPublicHttpUrl(url);
  const res = await fetch(parsed.toString(), {
    headers: {
      "User-Agent": `${SERVICE_USER_AGENT} (content extractor)`,
      "Accept": "text/html",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error("Too many redirects");
    }
    const location = res.headers.get("location");
    if (!location) throw new Error("Redirect missing location");
    const redirectedUrl = new URL(location, parsed).toString();
    await assertPublicHttpUrl(redirectedUrl);
    return fetchValidated(redirectedUrl, redirectCount + 1);
  }

  return res;
}

async function fetchAndExtract(url: string, maxChars: number): Promise<string> {
  const res = await fetchValidated(url);

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
