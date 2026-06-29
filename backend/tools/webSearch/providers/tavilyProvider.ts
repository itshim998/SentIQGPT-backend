// SentIQ Chat v2 — Tavily Search Provider
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
import {
  DEFAULT_WEB_SEARCH_MODE,
  normalizeWebSearchMode,
  type WebSearchMode,
} from "../webSearchMode";
import { keyManager } from "./tavilyKeyManager";

// ==============================
// Configuration
// ==============================

const TAVILY_API_ENDPOINT = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 15_000;

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
// Tavily Provider
// ==============================

export class TavilyProvider implements WebSearchProvider {
  readonly name = "Tavily Search";
  readonly source = "tavily" as const;

  isAvailable(): boolean {
    return keyManager.hasKeys() && keyManager.getAvailableCount() > 0;
  }

  async search(
    query: string,
    maxResults = 5,
    mode: WebSearchMode = DEFAULT_WEB_SEARCH_MODE,
    signal?: AbortSignal,
  ): Promise<readonly SearchResult[]> {
    const normalizedMode = normalizeWebSearchMode(mode);
    const data = await this.executeWithRotation(query, maxResults, (apiKey) =>
      this.executeRequest(query, apiKey, maxResults, normalizedMode, signal)
    );
    return this.mapResults(data, normalizedMode);
  }

  async searchWithMetadata(
    query: string,
    maxResults = 5,
    mode: WebSearchMode = DEFAULT_WEB_SEARCH_MODE,
    signal?: AbortSignal,
  ): Promise<{ results: SearchResult[]; answer?: string; images: string[] }> {
    const normalizedMode = normalizeWebSearchMode(mode);
    const data = await this.executeWithRotation(query, maxResults, (apiKey) =>
      this.executeRequest(query, apiKey, maxResults, normalizedMode, signal)
    );
    return {
      results: this.mapResults(data, normalizedMode),
      answer: typeof data.answer === "string" ? data.answer.trim() : undefined,
      images: [],
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
    maxResults: number,
    mode: WebSearchMode,
    signal?: AbortSignal,
  ): Promise<TavilyResponse> {
    const requestBody: Record<string, unknown> = {
      query,
      search_depth: "advanced",
      include_answer: "advanced",
      max_results: maxResults,
    };

    const response = await fetch(TAVILY_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  private mapResults(data: TavilyResponse, mode: WebSearchMode): SearchResult[] {
    return data.results.map((r) => ({
      title: r.title || "Untitled",
      url: r.url,
      snippet: r.content?.slice(0, 500) ?? "",
      content: r.content ?? "",
      images: [],
      favicon: undefined,
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
