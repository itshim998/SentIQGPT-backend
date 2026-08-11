// SentIQ Chat v2 — Cache Manager
//
// High-level API for the three cache categories:
//   1. LLM Answer Cache   — deterministic, context-free knowledge answers only
//   2. Web Search Cache    — caches search provider results
//   3. Embedding Cache     — caches text-embedding vectors
//
// Answer caching is intentionally strict. A conversational LLM response is
// not safely identified by the user's text alone: model choice, execution
// profile, context, tools, and prompt version can all change the result.
//
// Phase 1 emergency policy:
//   - final answers are NOT cached for coding, reasoning, file analysis,
//     personalized requests, explicit model selections, conversation history,
//     attachments, or tool/web-search requests.
//   - only explicitly marked deterministic, context-free knowledge answers
//     may use the answer cache.
//
// Phase 2 key shape is already implemented here so every future answer-cache
// caller is forced to provide the dimensions that define answer identity.

import { createHash } from "crypto";
import { cacheGet, cacheSet, cacheStats } from "./cacheStore";
import type { CacheCategory } from "./cacheTypes";
import type { SearchSource } from "../tools/webSearch/types";

// ==============================
// Generic key generation
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
 * Inputs that define the identity of a final LLM answer.
 *
 * The policy flags are deliberately explicit instead of inferred inside the
 * cache layer. The caller knows whether a turn contains history, files,
 * personalization, an explicit model selection, or tools.
 */
export interface AnswerCacheRequest {
  /** The user's actual intent/query text. */
  readonly userIntent: string;
  /** Product execution profile, e.g. "knowledge" / "fast" / "intuitive". */
  readonly executionProfile: string;
  /** Model capability used for the answer, e.g. "general_knowledge". */
  readonly modelCapability: string;
  /** Stable fingerprint of the context supplied to the model. */
  readonly contextFingerprint: string;
  /** Stable fingerprint of tools/search inputs. Use "none" for no tools. */
  readonly toolFingerprint: string;
  /** Version of the prompt/policy that produced the answer. */
  readonly promptVersion: string;

  // Phase 1 safety gates.
  readonly deterministicKnowledge: boolean;
  readonly hasConversationHistory: boolean;
  readonly hasAttachments: boolean;
  readonly isPersonalized: boolean;
  readonly hasExplicitModelSelection: boolean;
  readonly usesTools: boolean;
  readonly usesWebSearch: boolean;
}

/**
 * Phase 2 cache identity. Keep this shape stable: changing any member must
 * produce a different answer-cache key.
 */
export interface AnswerCacheKey {
  readonly userIntentHash: string;
  readonly executionProfile: string;
  readonly modelCapability: string;
  readonly contextFingerprint: string;
  readonly toolFingerprint: string;
  readonly promptVersion: string;
}

function hashIntent(userIntent: string): string {
  return createHash("sha256")
    .update(userIntent.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

/**
 * Build the context-aware Phase 2 answer identity.
 */
export function buildAnswerCacheKey(request: AnswerCacheRequest): AnswerCacheKey {
  return {
    userIntentHash: hashIntent(request.userIntent),
    executionProfile: request.executionProfile.trim().toLowerCase(),
    modelCapability: request.modelCapability.trim().toLowerCase(),
    contextFingerprint: request.contextFingerprint.trim(),
    toolFingerprint: request.toolFingerprint.trim(),
    promptVersion: request.promptVersion.trim(),
  };
}

function serializeAnswerCacheKey(key: AnswerCacheKey): string {
  // Length-prefix each component so separators can never create ambiguity.
  const parts = [
    key.userIntentHash,
    key.executionProfile,
    key.modelCapability,
    key.contextFingerprint,
    key.toolFingerprint,
    key.promptVersion,
  ];
  return parts.map((part) => `${part.length}:${part}`).join("");
}

/**
 * Strict Phase 1 policy: only deterministic, context-free knowledge answers
 * may enter the final-answer cache.
 */
export function isAnswerCacheable(request: AnswerCacheRequest): boolean {
  if (!request.deterministicKnowledge) return false;
  if (request.hasConversationHistory) return false;
  if (request.hasAttachments) return false;
  if (request.isPersonalized) return false;
  if (request.hasExplicitModelSelection) return false;
  if (request.usesTools) return false;
  if (request.usesWebSearch) return false;

  // A supposedly context-free answer must actually declare empty context/tool
  // fingerprints. This prevents callers from accidentally opting into the
  // cache while still supplying hidden context.
  if (request.contextFingerprint !== "none") return false;
  if (request.toolFingerprint !== "none") return false;

  return true;
}

/**
 * Check for a cached final answer.
 *
 * Unsafe requests always behave as cache misses. This is intentional: the
 * cache must never be allowed to decide whether a conversational request is
 * executable before routing/model selection.
 */
export function getCachedAnswer(request: AnswerCacheRequest): string | undefined {
  if (!isAnswerCacheable(request)) {
    console.log("[CACHE] bypass: llm_answer (non-deterministic/contextual request)");
    return undefined;
  }

  const answerKey = buildAnswerCacheKey(request);
  const key = makeKey("llm_answer", serializeAnswerCacheKey(answerKey));
  const hit = cacheGet<string>(key);
  if (hit !== undefined) {
    console.log("[CACHE] hit: llm_answer");
  } else {
    console.log("[CACHE] miss: llm_answer");
  }
  return hit;
}

/**
 * Store a final LLM reply only when the request passes the strict Phase 1
 * policy. Short/error-like replies are also excluded.
 */
export function setCachedAnswer(request: AnswerCacheRequest, reply: string): void {
  if (!isAnswerCacheable(request)) {
    console.log("[CACHE] bypass store: llm_answer (non-deterministic/contextual request)");
    return;
  }
  if (!reply || reply.length < 50) return;

  const answerKey = buildAnswerCacheKey(request);
  const key = makeKey("llm_answer", serializeAnswerCacheKey(answerKey));
  cacheSet(key, reply, "llm_answer");
  console.log("[CACHE] stored: llm_answer");
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
    content?: string;
    images?: string[];
    favicon?: string;
    body?: string;
    source: SearchSource;
    score?: number;
  }[];
  readonly provider_used?: string;
}

/** Check for cached web search results. */
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

/** Store web search results in the cache. */
export function setCachedSearchResults(query: string, result: CachedSearchResult): void {
  if (!result.success || result.results.length === 0) return;

  const key = makeKey("web_search", query.trim().toLowerCase());
  cacheSet(key, result, "web_search");
  console.log(`[CACHE] stored: web_search`);
}

/**
 * Pass-A-only cache helpers. They deliberately share the bounded web-search
 * bucket but use a separate namespace and caller-provided TTL, so legacy
 * router behaviour and the public search endpoints remain unchanged.
 */
export function getCachedWebSurfSearch<T>(identity: string): T | undefined {
  const key = makeKey("web_search", "websurf-v2.1", identity);
  const hit = cacheGet<T>(key);
  console.log(`[CACHE] ${hit === undefined ? "miss" : "hit"}: websurf-v2.1`);
  return hit;
}

export function setCachedWebSurfSearch<T>(identity: string, value: T, ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const key = makeKey("web_search", "websurf-v2.1", identity);
  cacheSet(key, value, "web_search", ttlMs);
  console.log(`[CACHE] stored: websurf-v2.1 ttl_ms=${ttlMs}`);
}

// ==============================
// 3. Embedding Cache
// ==============================

/** Check for a cached embedding vector. */
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

/** Store an embedding vector in the cache. */
export function setCachedEmbedding(text: string, embedding: number[]): void {
  if (!embedding || embedding.length === 0) return;

  const key = makeKey("embedding", text.trim().toLowerCase());
  cacheSet(key, embedding, "embedding");
  console.log(`[CACHE] stored: embedding`);
}

// ==============================
// Diagnostics
// ==============================

/** Log current cache statistics. */
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
