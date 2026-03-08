// SentIQGPT v2 — Image Router
//
// Sequential fallback router with per-provider cooldowns and retry.
// Tries each provider in priority order; returns as soon as one succeeds.
//
// Provider chain (Pollinations-first):
//   1. Flux Schnell  (primary — uses FLUX_API_KEY if set)
//   2. FLUX.2 Dev    (fallback — uses FLUX_API_KEY if set)
//   3. Z-Image Turbo (secondary fallback — uses FLUX_API_KEY if set)
//   4. HuggingFace   (requires HUGGINGFACE_API_TOKEN)
//
// Features:
//   - Strictly sequential execution (never parallel)
//   - 30-second cooldown on HTTP 429
//   - 20-second AbortController timeout per attempt
//   - Single retry after 1-second wait on 429
//
// FLUX_API_KEY is optional — Pollinations works on free tier without it.
// If ALL providers fail, returns a structured error — never crashes.

import type { ImageProvider, ImageGenerationResult } from "./types";
import { FluxSchnellProvider } from "./providers/fluxSchnellProvider";
import { FluxDevProvider } from "./providers/fluxDevProvider";
import { PollinationsProvider } from "./providers/pollinationsProvider";
import { HuggingFaceProvider } from "./providers/huggingfaceProvider";

// ==============================
// Provider registry (order = priority)
// ==============================

const providers: readonly ImageProvider[] = [
  new FluxSchnellProvider(),   // 1. Pollinations Flux Schnell (primary)
  new FluxDevProvider(),        // 2. Pollinations FLUX.2 Dev   (fallback)
  new PollinationsProvider(),   // 3. Pollinations Z-Image Turbo (secondary fallback)
  new HuggingFaceProvider(),    // 4. HuggingFace SDXL          (API key fallback)
];

// ==============================
// Per-provider cooldown tracking
// ==============================

const COOLDOWN_MS = 30_000;
const providerCooldownUntil: Map<string, number> = new Map();

function isOnCooldown(name: string): boolean {
  const until = providerCooldownUntil.get(name);
  if (!until) return false;
  if (Date.now() >= until) { providerCooldownUntil.delete(name); return false; }
  return true;
}

function setCooldown(name: string): void {
  providerCooldownUntil.set(name, Date.now() + COOLDOWN_MS);
}

// ==============================
// Helpers
// ==============================

function is429(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("rate limit");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==============================
// Router
// ==============================

/**
 * Route an image generation request through the provider chain.
 *
 * Iterates providers **sequentially** in priority order. For each:
 *   1. Skip if on cooldown or `isAvailable()` returns false.
 *   2. Call `generate()` — return on success.
 *   3. On 429: wait 1 s, retry once. If still 429, set 30 s cooldown.
 *   4. On any failure: log and try next provider.
 */
export async function routeImageGeneration(args: {
  readonly prompt: string;
  readonly size?: string;
}): Promise<ImageGenerationResult> {
  if (!args.prompt.trim()) {
    return { success: false, prompt: args.prompt, error: "Prompt is required" };
  }

  const errors: string[] = [];
  const hasFluxKey = Boolean(process.env.FLUX_API_KEY);
  const startTime = Date.now();
  console.log(`[IMAGE] routing prompt="${args.prompt.slice(0, 60)}..." flux_key=${hasFluxKey ? "configured" : "free_tier"}`);

  for (const provider of providers) {
    // Skip unavailable providers (missing API keys, etc.)
    if (!provider.isAvailable()) {
      console.log(`[IMAGE] provider=${provider.name} skipped reason=not_configured`);
      errors.push(`${provider.name}: not configured`);
      continue;
    }

    // Skip providers on cooldown from recent 429
    if (isOnCooldown(provider.name)) {
      console.log(`[IMAGE] provider=${provider.name} skipped reason=cooldown`);
      errors.push(`${provider.name}: on cooldown`);
      continue;
    }

    // Attempt with optional single retry on 429
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[IMAGE] provider=${provider.name} attempt=${attempt}`);
        const result = await provider.generate(args.prompt, args.size);
        const elapsed = Date.now() - startTime;
        console.log(`[IMAGE] provider=${provider.name} success duration=${elapsed}ms`);
        return {
          success: true,
          image_url: result.url,
          image_base64: result.base64,
          provider_used: provider.name,
          prompt: args.prompt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (is429(err) && attempt === 1) {
          console.log(`[IMAGE] provider=${provider.name} got 429, retrying in 1s`);
          await sleep(1000);
          continue; // retry once
        }

        // Final failure for this provider
        if (is429(err)) setCooldown(provider.name);
        console.log(`[IMAGE] provider=${provider.name} failed error="${message}"`);
        errors.push(`${provider.name}: ${message}`);
        break; // move to next provider
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[IMAGE] all_providers_failed duration=${elapsed}ms`);
  return {
    success: false,
    prompt: args.prompt,
    error: `All image providers failed. ${errors.join(" | ")}`,
  };
}
