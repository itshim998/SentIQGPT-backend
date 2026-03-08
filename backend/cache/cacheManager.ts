// SentIQGPT v2 — Cache Manager
//
// High-level API for the three cache categories:
//   1. LLM Answer Cache   — caches Gemini conversation replies
//   2. Web Search Cache    — caches search provider results
//   3. Embedding Cache     — caches text-embedding-004 vectors
//
// Each function produces a deterministic cache key from the input,
// then delegates to the underlying cacheStore.
//
// Safety: only general-knowledge responses and search results are
// cached. Personal memory objects and sensitive data never enter the cache.

import { createHash } from "crypto";
import { cacheGet, cacheSet, cacheStats } from "./cacheStore";
import type { CacheCategory } from "./cacheTypes";
import type { SearchSource } from "../tools/webSearch/types";

// ==============================
// Key generation
// ==============================

/**
 * Produce a deterministic, collision-resistant cache key.
 * Uses SHA-256 truncated to 32 hex chars (128 bits).
 */
function makeKey(category: CacheCategory, ...parts: string[]): string {
  const raw = `${category}:${parts.join("|")}`;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return `${category}:${hash}`;
}

// ==============================
// 1. LLM Answer Cache
// ==============================

/**
 * Check for a cached LLM answer matching the user query.
 * Returns the cached reply string, or `undefined` on miss.
 */
export function getCachedAnswer(userQuery: string): string | undefined {
  const key = makeKey("llm_answer", userQuery.trim().toLowerCase());
  const hit = cacheGet<string>(key);
  if (hit !== undefined) {
    console.log(`[CACHE] hit: llm_answer`);
  } else {
    console.log(`[CACHE] miss: llm_answer`);
  }
  return hit;
}

/**
 * Store a final LLM reply in the answer cache.
 *
 * Safety guard: skips caching if the reply is very short or looks
 * like an error message, to avoid polluting the cache.
 */
export function setCachedAnswer(userQuery: string, reply: string): void {
  if (!reply || reply.length < 50) return;

  const key = makeKey("llm_answer", userQuery.trim().toLowerCase());
  cacheSet(key, reply, "llm_answer");
  console.log(`[CACHE] stored: llm_answer`);
}

// ==============================
// 2. Web Search Cache
// ==============================

/** Cached web search result shape (matches WebSearchResult). */
export interface CachedSearchResult {
  readonly success: boolean;
  readonly query: string;
  readonly results: readonly {
    title: string;
    url: string;
    snippet: string;
    body?: string;
    source: SearchSource;
  }[];
  readonly provider_used?: string;
}

/**
 * Check for cached web search results.
 */
export function getCachedSearchResults(query: string): CachedSearchResult | undefined {
  const key = makeKey("web_search", query.trim().toLowerCase());
  const hit = cacheGet<CachedSearchResult>(key);
  if (hit !== undefined) {
    console.log(`[CACHE] hit: web_search`);
  } else {
    console.log(`[CACHE] miss: web_search`);
  }
  return hit;
}

/**
 * Store web search results in the cache.
 */
export function setCachedSearchResults(query: string, result: CachedSearchResult): void {
  if (!result.success || result.results.length === 0) return;

  const key = makeKey("web_search", query.trim().toLowerCase());
  cacheSet(key, result, "web_search");
  console.log(`[CACHE] stored: web_search`);
}

// ==============================
// 3. Embedding Cache
// ==============================

/**
 * Check for a cached embedding vector.
 */
export function getCachedEmbedding(text: string): number[] | undefined {
  const key = makeKey("embedding", text.trim().toLowerCase());
  const hit = cacheGet<number[]>(key);
  if (hit !== undefined) {
    console.log(`[CACHE] hit: embedding`);
  } else {
    console.log(`[CACHE] miss: embedding`);
  }
  return hit;
}

/**
 * Store an embedding vector in the cache.
 */
export function setCachedEmbedding(text: string, embedding: number[]): void {
  if (!embedding || embedding.length === 0) return;

  const key = makeKey("embedding", text.trim().toLowerCase());
  cacheSet(key, embedding, "embedding");
  console.log(`[CACHE] stored: embedding`);
}

// ==============================
// Diagnostics
// ==============================

/**
 * Log current cache statistics.
 */
export function logCacheStats(): void {
  const stats = cacheStats();
  console.log(
    `[CACHE] stats — total: ${stats.totalEntries}, ` +
    `hits: ${stats.hits}, misses: ${stats.misses} | ` +
    `llm: ${stats.byCategory.llm_answer}, ` +
    `search: ${stats.byCategory.web_search}, ` +
    `embed: ${stats.byCategory.embedding}`,
  );
}
