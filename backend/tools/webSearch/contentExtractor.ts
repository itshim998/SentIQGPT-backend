// SentIQ Chat v2 — Content Extractor
//
// Lightweight HTML-to-text extraction for web search results.
// Fetches a URL and strips scripts, styles, nav, ads, and other
// non-content elements to produce clean body text.
//
// Character limit: ~1500 per page to stay within LLM context budgets.

import type { SearchResult } from "./types";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { SERVICE_USER_AGENT } from "../../branding";

const MAX_BODY_CHARS = 1500;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_EXTRACT_RESPONSE_BYTES = 512 * 1024;
const MAX_METADATA_RESPONSE_BYTES = 256 * 1024;

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
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const enriched: SearchResult[] = [];

  for (const result of results) {
    // Skip if already has body or no URL
    if (result.body || !result.url) {
      enriched.push({ ...result });
      continue;
    }

    try {
      const body = await fetchAndExtract(result.url, maxPerPage, signal);
      enriched.push({ ...result, body });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Keep result as-is (snippet only)
      enriched.push({ ...result });
    }
  }

  return enriched;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

// Node's BlockList may normalize IPv4 checks through IPv4-mapped IPv6. Keeping
// the families separate prevents an IPv6 mapped-address rule from matching
// every ordinary IPv4 address.
const NON_PUBLIC_IPV4_ADDRESSES = new BlockList();
const NON_PUBLIC_IPV6_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_IPV4_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_IPV6_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function extractMappedIPv4(address: string): string | null {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith("::ffff:")) return null;
  const suffix = normalized.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const groups = suffix.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export function isPrivateOrInternalAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return NON_PUBLIC_IPV4_ADDRESSES.check(normalized, "ipv4");
  if (family === 6) {
    const mapped = extractMappedIPv4(normalized);
    if (mapped) return NON_PUBLIC_IPV4_ADDRESSES.check(mapped, "ipv4");
    return NON_PUBLIC_IPV6_ADDRESSES.check(normalized, "ipv6");
  }
  return false;
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

export async function assertPublicHttpUrl(url: string, resolver: DnsResolver = DEFAULT_DNS_RESOLVER): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credential-bearing URLs are not allowed");
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

/**
 * Validate a source URL which is only presented to the browser. Unlike a
 * server-side fetch, presenting a link must not depend on a live DNS lookup:
 * a transient resolver failure is not evidence that a public HTTPS result is
 * unsafe. Server-side fetches still use assertPublicHttpUrl and DNS pinning.
 */
export function assertSafeWebSurfPresentationUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS source URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credential-bearing URLs are not allowed");
  }
  if (isPrivateOrInternalHost(parsed.hostname)) {
    throw new Error("Private/internal URLs are blocked");
  }
  return parsed;
}

async function resolvePinnedPublicAddress(parsed: URL): Promise<{ address: string; family: 4 | 6 }> {
  const host = normalizeHostname(parsed.hostname);
  if (isPrivateOrInternalHost(host)) throw new Error("Private/internal URLs are blocked");
  if (isIP(host) === 4 || isIP(host) === 6) {
    return { address: host, family: isIP(host) as 4 | 6 };
  }
  const addresses = await DEFAULT_DNS_RESOLVER(host);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrInternalAddress(address))) {
    throw new Error("Private/internal URLs are blocked");
  }
  const selected = addresses.find(({ address }) => isIP(address) === 4) ?? addresses[0];
  const family = isIP(selected.address);
  if (family !== 4 && family !== 6) throw new Error("URL host did not resolve to an IP address");
  return { address: selected.address, family };
}

function getHeader(response: IncomingMessage, name: string): string {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

type ValidatedIncomingMessage = IncomingMessage & { validatedUrl?: string };

async function requestPinned(parsed: URL, signal?: AbortSignal, method: "GET" | "HEAD" = "GET"): Promise<ValidatedIncomingMessage> {
  const pinned = await resolvePinnedPublicAddress(parsed);
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const requestImpl = parsed.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<ValidatedIncomingMessage>((resolve, reject) => {
    const request = requestImpl({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: {
        "User-Agent": `${SERVICE_USER_AGENT} (content extractor)`,
        "Accept": "image/*,text/html;q=0.9,text/plain;q=0.8",
        "Accept-Encoding": "identity",
        "Host": parsed.host,
      },
      signal: effectiveSignal,
      servername: parsed.protocol === "https:" ? parsed.hostname : undefined,
      lookup: ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
        // Newer Node runtimes may request dns.lookup({ all: true }) while
        // auto-selecting an address family. Preserve the one validated pinned
        // address while honoring that callback shape.
        if (
          typeof options === "object"
          && options !== null
          && "all" in options
          && (options as { all?: unknown }).all === true
        ) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
          return;
        }
        callback(null, pinned.address, pinned.family);
      }) as any,
    }, (response) => {
      const validatedResponse = response as ValidatedIncomingMessage;
      validatedResponse.validatedUrl = parsed.toString();
      resolve(validatedResponse);
    });
    request.once("error", reject);
    request.end();
  });
}

async function fetchValidated(
  url: string,
  redirectCount = 0,
  signal?: AbortSignal,
  method: "GET" | "HEAD" = "GET",
): Promise<ValidatedIncomingMessage> {
  const parsed = await assertPublicHttpUrl(url);
  const res = await requestPinned(parsed, signal, method);

  if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
    if (redirectCount >= MAX_REDIRECTS) {
      res.destroy();
      throw new Error("Too many redirects");
    }
    const location = getHeader(res, "location");
    if (!location) throw new Error("Redirect missing location");
    const redirected = new URL(location, parsed);
    if (parsed.protocol === "https:" && redirected.protocol !== "https:") {
      res.destroy();
      throw new Error("HTTPS URLs cannot redirect to an insecure protocol");
    }
    const redirectedUrl = redirected.toString();
    await assertPublicHttpUrl(redirectedUrl);
    res.destroy();
    return fetchValidated(redirectedUrl, redirectCount + 1, signal, method);
  }

  return res;
}

async function readResponseTextLimited(response: IncomingMessage, maxBytes: number): Promise<string> {
  const declaredLength = Number.parseInt(getHeader(response, "content-length"), 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy();
    throw new Error("Response body exceeded the allowed size");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      response.destroy();
      throw new Error("Response body exceeded the allowed size");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface WebSurfArticleMetadata {
  readonly published_at?: string;
  readonly favicon_url?: string;
  readonly thumbnail_url?: string;
}

function getMetaContent(html: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapedName}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export function getLinkHref(html: string, relName: string): string | undefined {
  const escapedRel = relName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<link[^>]+rel=["'][^"']*\\b${escapedRel}\\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*\\b${escapedRel}\\b[^"']*["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

async function validateHttpsAssetUrl(
  rawUrl: string | undefined,
  pageUrl: URL,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl, pageUrl);
    if (parsed.protocol !== "https:") return undefined;
    await assertPublicHttpUrl(parsed.toString());
    const response = await fetchValidated(parsed.toString(), 0, signal, "HEAD");
    const finalUrl = new URL(response.validatedUrl ?? parsed.toString());
    const statusCode = response.statusCode ?? 0;
    const contentType = getHeader(response, "content-type");
    response.destroy();
    if (finalUrl.protocol !== "https:" || statusCode < 200 || statusCode >= 400) return undefined;
    if (contentType && !contentType.toLowerCase().startsWith("image/")) return undefined;
    return finalUrl.toString();
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/**
 * Read the small, presentation-only metadata surface used by WebSurf V2.
 * This deliberately does not proxy or fetch candidate image assets: a page's
 * Open Graph image, Twitter card image, or HTTPS favicon is merely returned
 * after server-side URL validation. Any failure is non-fatal for the search.
 */
export async function fetchWebSurfArticleMetadata(url: string, signal?: AbortSignal): Promise<WebSurfArticleMetadata> {
  const pageUrl = await assertPublicHttpUrl(url);
  const response = await fetchValidated(pageUrl.toString(), 0, signal);
  const statusCode = response.statusCode ?? 0;
  if (statusCode < 200 || statusCode >= 300 || !getHeader(response, "content-type").includes("text/html")) {
    response.destroy();
    return {};
  }

  const html = await readResponseTextLimited(response, MAX_METADATA_RESPONSE_BYTES);
  const thumbnailCandidate = getMetaContent(html, "og:image")
    ?? getMetaContent(html, "twitter:image")
    ?? getMetaContent(html, "twitter:image:src");
  const faviconFromDocument = getLinkHref(html, "icon") ?? getLinkHref(html, "shortcut icon");
  const [thumbnail_url, favicon_url] = await Promise.all([
    validateHttpsAssetUrl(thumbnailCandidate, pageUrl, signal),
    validateHttpsAssetUrl(faviconFromDocument ?? `https://${pageUrl.hostname}/favicon.ico`, pageUrl, signal),
  ]);
  const published_at = getMetaContent(html, "article:published_time")
    ?? getMetaContent(html, "date")
    ?? getMetaContent(html, "publish-date");

  return {
    published_at: published_at?.slice(0, 128),
    favicon_url,
    thumbnail_url,
  };
}

async function fetchAndExtract(url: string, maxChars: number, signal?: AbortSignal): Promise<string> {
  const res = await fetchValidated(url, 0, signal);

  const statusCode = res.statusCode ?? 0;
  if (statusCode < 200 || statusCode >= 300) {
    res.destroy();
    throw new Error(`HTTP ${statusCode}`);
  }

  const contentType = getHeader(res, "content-type");
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const html = await readResponseTextLimited(res, MAX_EXTRACT_RESPONSE_BYTES);
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
