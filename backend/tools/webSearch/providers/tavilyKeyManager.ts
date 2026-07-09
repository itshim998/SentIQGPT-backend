// SentIQ Chat v2 — Shared Tavily Key Manager
//
// Manages rotation, cooldowns, and retries across multiple keys.

import { bootProfiler } from "../../../bootProfiler";

const COOLDOWN_MS = 60_000; // 60 seconds cooldown for failed keys

export type TavilyKeyManagerOptions = {
  keys?: readonly string[];
  now?: () => number;
  cooldownMs?: number;
};

export interface KeyState {
  key: string;
  cooldownUntil: number; // timestamp when key can be used again
  failCount: number;
}

export class TavilyKeyManager {
  private keys: KeyState[] = [];
  private currentIndex = 0;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(options: TavilyKeyManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
    this.loadKeys(options.keys);
  }

  private loadKeys(configuredKeys?: readonly string[]): void {
    const rawKeys = (configuredKeys ?? (process.env.TAVILY_KEYS ?? "").split(","))
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    const uniqueKeys = [...new Set(rawKeys)];

    this.keys = uniqueKeys.map((key) => ({
      key,
      cooldownUntil: 0,
      failCount: 0,
    }));

    if (this.keys.length > 0) {
      console.log(`[Tavily] loaded ${this.keys.length} API key(s)`);
    }
    bootProfiler.mark("tavily.keys.loaded");
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

    const now = this.now();
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
  markFailed(key: string, isRateLimit: boolean, retryAfterMs?: number): void {
    const keyState = this.keys.find((k) => k.key === key);
    if (!keyState) return;

    keyState.failCount++;
    // Apply longer cooldown for rate limits, shorter for other failures
    const defaultCooldown = isRateLimit ? this.cooldownMs * 2 : this.cooldownMs;
    const cooldown = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
      ? Math.max(defaultCooldown, Math.max(0, retryAfterMs))
      : defaultCooldown;
    keyState.cooldownUntil = this.now() + cooldown;

    console.log(
      `[Tavily] API key marked unavailable (failure count: ${keyState.failCount}, cooldown: ${Math.ceil(cooldown / 1000)}s)`
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
    const now = this.now();
    return this.keys.filter((k) => k.cooldownUntil <= now).length;
  }

  getTotalCount(): number {
    return this.keys.length;
  }
}

// Singleton key manager
export const keyManager = new TavilyKeyManager();
