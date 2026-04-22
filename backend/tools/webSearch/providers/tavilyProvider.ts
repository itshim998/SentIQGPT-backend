// SentIQGPT v2 — Tavily Search Provider
//
// Production-grade Tavily integration with:
//   - Multi-key round-robin rotation
//   - Cooldown system for failed keys (60s before reuse)
//   - Rate limit (429) and auth error (401) detection
//   - Automatic retry across all available keys
//
// Tavily returns structured results with relevance scores,
// making it ideal for AI research-style queries.

import type { WebSearchProvider, SearchResult } from "../types";

// ==============================
// Configuration
// ==============================

const TAVILY_API_ENDPOINT = "https://api.tavily.com/search";
const COOLDOWN_MS = 60_000; // 60 seconds cooldown for failed keys
const REQUEST_TIMEOUT_MS = 15_000;

interface KeyState {
  key: string;
  cooldownUntil: number; // timestamp when key can be used again
  failCount: number;
}

// ==============================
// Tavily API Types
// ==============================

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  images?: string[];
  favicon?: string;
}

interface TavilyResponse {
  results: TavilySearchResult[];
  answer?: string;
  query: string;
  images?: string[];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
}

// ==============================
// Key Manager (Round-Robin with Cooldown)
// ==============================

class TavilyKeyManager {
  private keys: KeyState[] = [];
  private currentIndex = 0;

  constructor() {
    this.loadKeys();
  }

  private loadKeys(): void {
    const keysEnv = process.env.TAVILY_KEYS ?? "";
    const rawKeys = keysEnv
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    this.keys = rawKeys.map((key) => ({
      key,
      cooldownUntil: 0,
      failCount: 0,
    }));

    if (this.keys.length > 0) {
      console.log(`[Tavily] loaded ${this.keys.length} API key(s)`);
    }
  }

  hasKeys(): boolean {
    return this.keys.length > 0;
  }

  /**
   * Get the next available key using round-robin.
   * Skips keys that are in cooldown.
   * Returns null if all keys are unavailable.
   */
  getNextKey(): string | null {
    if (this.keys.length === 0) return null;

    const now = Date.now();
    const startIndex = this.currentIndex;

    // Try each key starting from current index
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (startIndex + i) % this.keys.length;
      const keyState = this.keys[idx];

      if (keyState.cooldownUntil <= now) {
        this.currentIndex = (idx + 1) % this.keys.length;
        return keyState.key;
      }
    }

    // All keys are in cooldown
    return null;
  }

  /**
   * Mark a key as failed and apply cooldown.
   */
  markFailed(key: string, isRateLimit: boolean): void {
    const keyState = this.keys.find((k) => k.key === key);
    if (!keyState) return;

    keyState.failCount++;
    // Apply longer cooldown for rate limits, shorter for other failures
    const cooldown = isRateLimit ? COOLDOWN_MS * 2 : COOLDOWN_MS;
    keyState.cooldownUntil = Date.now() + cooldown;

    console.log(
      `[Tavily] key ${key.slice(0, 8)}... marked failed (count: ${keyState.failCount}, cooldown: ${cooldown / 1000}s)`
    );
  }

  /**
   * Mark a key as successful (reset fail count).
   */
  markSuccess(key: string): void {
    const keyState = this.keys.find((k) => k.key === key);
    if (keyState) {
      keyState.failCount = 0;
    }
  }

  /**
   * Get count of available keys (not in cooldown).
   */
  getAvailableCount(): number {
    const now = Date.now();
    return this.keys.filter((k) => k.cooldownUntil <= now).length;
  }

  getTotalCount(): number {
    return this.keys.length;
  }
}

// Singleton key manager
const keyManager = new TavilyKeyManager();

// ==============================
// Tavily Provider
// ==============================

export class TavilyProvider implements WebSearchProvider {
  readonly name = "Tavily Search";
  readonly source = "tavily" as const;

  isAvailable(): boolean {
    return keyManager.hasKeys() && keyManager.getAvailableCount() > 0;
  }

  async search(query: string, maxResults = 5): Promise<readonly SearchResult[]> {
    const data = await this.executeWithRotation(query, maxResults, (apiKey) =>
      this.executeRequest(query, apiKey, maxResults)
    );
    return this.mapResults(data);
  }

  async searchWithMetadata(
    query: string,
    maxResults = 5
  ): Promise<{ results: SearchResult[]; answer?: string; images: string[] }> {
    const data = await this.executeWithRotation(query, maxResults, (apiKey) =>
      this.executeRequest(query, apiKey, maxResults)
    );
    return {
      results: this.mapResults(data),
      answer: typeof data.answer === "string" ? data.answer.trim() : undefined,
      images: normalizeStringArray(data.images),
    };
  }

  private async executeWithRotation<T>(
    query: string,
    maxResults: number,
    runner: (apiKey: string) => Promise<T>
  ): Promise<T> {
    const totalKeys = keyManager.getTotalCount();
    if (totalKeys === 0) {
      throw new Error("No Tavily API keys configured");
    }

    let lastError: Error | null = null;

    // Try up to totalKeys times (each key once)
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const apiKey = keyManager.getNextKey();
      if (!apiKey) {
        throw new Error("All Tavily API keys are in cooldown");
      }

      try {
        const result = await runner(apiKey);
        keyManager.markSuccess(apiKey);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const isRateLimit = lastError.message.includes("429");
        const isAuthError = lastError.message.includes("401");

        if (isRateLimit || isAuthError) {
          keyManager.markFailed(apiKey, isRateLimit);
          console.log(
            `[Tavily] key ${apiKey.slice(0, 8)}... failed with ${isRateLimit ? "rate limit" : "auth error"}, trying next...`
          );
        } else {
          // Non-recoverable error (e.g., network failure)
          keyManager.markFailed(apiKey, false);
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error("All Tavily API keys failed");
  }

  private async executeRequest(
    query: string,
    apiKey: string,
    maxResults: number
  ): Promise<TavilyResponse> {
    const response = await fetch(TAVILY_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        include_answer: "advanced",
        include_images: true,
        include_favicon: true,
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const statusText = response.statusText || "Unknown error";
      throw new Error(`Tavily API ${response.status}: ${statusText}`);
    }

    const data = (await response.json()) as TavilyResponse;

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid Tavily response: missing results array");
    }

    console.log(
      `[Tavily] returned ${data.results.length} result(s) for "${query.slice(0, 50)}..."`
    );

    return data;
  }

  private mapResults(data: TavilyResponse): SearchResult[] {
    return data.results.map((r) => ({
      title: r.title || "Untitled",
      url: r.url,
      snippet: r.content?.slice(0, 500) ?? "",
      content: r.content ?? "",
      images: normalizeStringArray(r.images),
      favicon: r.favicon ? String(r.favicon) : undefined,
      source: this.source,
      score: r.score,
    }));
  }
}

// ==============================
// Utility Exports
// ==============================

/**
 * Check if Tavily is configured and available.
 */
export function isTavilyAvailable(): boolean {
  return keyManager.hasKeys();
}

/**
 * Get Tavily key status for diagnostics.
 */
export function getTavilyKeyStatus(): {
  total: number;
  available: number;
} {
  return {
    total: keyManager.getTotalCount(),
    available: keyManager.getAvailableCount(),
  };
}
