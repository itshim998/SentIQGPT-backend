// SentIQGPT v2 — Knowledge Cache Types
//
// Shared interfaces for the in-memory cache layer.

/**
 * Cache categories — each has its own TTL and eviction policy.
 */
export type CacheCategory = "llm_answer" | "web_search" | "embedding";

/**
 * A single cached entry stored by the cache store.
 */
export interface CacheEntry<T = unknown> {
  /** The cached value. */
  readonly value: T;
  /** Category this entry belongs to. */
  readonly category: CacheCategory;
  /** Unix timestamp (ms) when the entry was created. */
  readonly createdAt: number;
  /** Unix timestamp (ms) when the entry expires. */
  readonly expiresAt: number;
  /** Number of times this entry has been retrieved. */
  hitCount: number;
}

/**
 * TTL durations per category (in milliseconds).
 */
export const CACHE_TTL: Readonly<Record<CacheCategory, number>> = {
  llm_answer: 6 * 60 * 60 * 1000,       //  6 hours
  web_search: 12 * 60 * 60 * 1000,       // 12 hours
  embedding:  30 * 24 * 60 * 60 * 1000,  // 30 days
};

/**
 * Maximum entries per category to bound memory usage on free tier.
 */
export const CACHE_MAX_ENTRIES: Readonly<Record<CacheCategory, number>> = {
  llm_answer: 200,
  web_search: 100,
  embedding:  500,
};

/**
 * Cache statistics for diagnostic logging.
 */
export interface CacheStats {
  readonly totalEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly byCategory: Readonly<Record<CacheCategory, number>>;
}
