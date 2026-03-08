// SentIQGPT v2 — Cache Store
//
// In-memory key-value store with TTL expiration and LRU-style eviction.
// Each cache category has an independent size cap to bound total memory
// usage on Render free tier (~512 MB RAM).
//
// No external dependencies — uses a plain Map.
//
// Eviction strategy: when a category hits its max size, the entry
// with the oldest `createdAt` and lowest `hitCount` is dropped.

import type { CacheEntry, CacheCategory } from "./cacheTypes";
import { CACHE_TTL, CACHE_MAX_ENTRIES } from "./cacheTypes";

// ==============================
// Store singleton
// ==============================

const store = new Map<string, CacheEntry>();

// Stats counters
let totalHits = 0;
let totalMisses = 0;

// ==============================
// Public API
// ==============================

/**
 * Retrieve a cached value by its key.
 * Returns `undefined` on miss or expiration.
 */
export function cacheGet<T = unknown>(key: string): T | undefined {
  const entry = store.get(key);

  if (!entry) {
    totalMisses++;
    return undefined;
  }

  // Check TTL
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    totalMisses++;
    return undefined;
  }

  entry.hitCount++;
  totalHits++;
  return entry.value as T;
}

/**
 * Store a value under the given key and category.
 * Handles TTL assignment and eviction if the category is at capacity.
 */
export function cacheSet<T = unknown>(
  key: string,
  value: T,
  category: CacheCategory,
): void {
  // Evict if at capacity for this category
  evictIfNeeded(category);

  const now = Date.now();
  const entry: CacheEntry = {
    value,
    category,
    createdAt: now,
    expiresAt: now + CACHE_TTL[category],
    hitCount: 0,
  };

  store.set(key, entry);
}

/**
 * Check whether a key exists and is not expired.
 */
export function cacheHas(key: string): boolean {
  const entry = store.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return false;
  }
  return true;
}

/**
 * Delete a specific key.
 */
export function cacheDelete(key: string): void {
  store.delete(key);
}

/**
 * Remove all expired entries across every category.
 */
export function cachePurgeExpired(): number {
  const now = Date.now();
  let purged = 0;
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(key);
      purged++;
    }
  }
  return purged;
}

/**
 * Clear all entries (useful for testing / shutdown).
 */
export function cacheClear(): void {
  store.clear();
  totalHits = 0;
  totalMisses = 0;
}

/**
 * Return aggregate cache statistics.
 */
export function cacheStats(): {
  totalEntries: number;
  hits: number;
  misses: number;
  byCategory: Record<CacheCategory, number>;
} {
  const byCategory: Record<CacheCategory, number> = {
    llm_answer: 0,
    web_search: 0,
    embedding: 0,
  };

  for (const entry of store.values()) {
    byCategory[entry.category]++;
  }

  return {
    totalEntries: store.size,
    hits: totalHits,
    misses: totalMisses,
    byCategory,
  };
}

// ==============================
// Eviction
// ==============================

function countCategory(category: CacheCategory): number {
  let count = 0;
  for (const entry of store.values()) {
    if (entry.category === category) count++;
  }
  return count;
}

/**
 * If the category is at or above its max, drop the least valuable entry
 * (oldest creation time, fewest hits).
 */
function evictIfNeeded(category: CacheCategory): void {
  const max = CACHE_MAX_ENTRIES[category];
  if (countCategory(category) < max) return;

  let worstKey: string | undefined;
  let worstScore = Infinity;

  for (const [key, entry] of store) {
    if (entry.category !== category) continue;

    // Also evict expired entries opportunistically
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return; // freed a slot
    }

    // Score: lower is worse (older + fewer hits = lower)
    const score = entry.hitCount * 1000 + entry.createdAt / 1000;
    if (score < worstScore) {
      worstScore = score;
      worstKey = key;
    }
  }

  if (worstKey) {
    store.delete(worstKey);
  }
}

// ==============================
// Periodic cleanup (runs every 10 minutes)
// ==============================

const CLEANUP_INTERVAL = 10 * 60 * 1000;

setInterval(() => {
  const purged = cachePurgeExpired();
  if (purged > 0) {
    console.log(`[CACHE] periodic cleanup: purged ${purged} expired entries`);
  }
}, CLEANUP_INTERVAL).unref(); // .unref() so it doesn't keep the process alive
