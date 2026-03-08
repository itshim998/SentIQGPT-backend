// SentIQGPT v2 — Image Router
//
// Sequential fallback router with per-provider cooldowns, retry, and queue.
// Tries each provider in priority order; returns as soon as one succeeds.
//
// Provider chain:
//   1. Pollinations Flux Schnell  (primary — Pollinations CDN)
//   2. HuggingFace SDXL           (requires HUGGINGFACE_API_TOKEN)
//   3. FLUX.2 Dev                 (Pollinations fallback)
//   4. Z-Image Turbo              (Pollinations fallback)
//
// Features:
//   - Global queue: max 1 concurrent job, max 10 queued requests
//   - Strictly sequential provider execution (never parallel)
//   - 30-second cooldown on HTTP 429
//   - 20-second AbortController timeout per Pollinations attempt
//   - 60-second timeout for HuggingFace (slow inference)
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
  new HuggingFaceProvider(),   // 2. HuggingFace SDXL (fast fallback with API key)
  new FluxDevProvider(),        // 3. Pollinations FLUX.2 Dev
  new PollinationsProvider(),   // 4. Pollinations Z-Image Turbo
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
// Image Generation Queue
// ==============================

const MAX_QUEUE_SIZE = 10;
let isProcessing = false;

interface QueueItem {
  args: { readonly prompt: string; readonly size?: string };
  resolve: (result: ImageGenerationResult) => void;
  reject: (err: Error) => void;
}

const imageQueue: QueueItem[] = [];

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  while (imageQueue.length > 0) {
    const item = imageQueue.shift()!;
    try {
      const result = await executeImageGeneration(item.args);
      item.resolve(result);
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  isProcessing = false;
}

// ==============================
// Router (public entry point)
// ==============================

/**
 * Route an image generation request through the queue and provider chain.
 * Only one image generation job runs at a time. Max queue size: 10.
 */
export async function routeImageGeneration(args: {
  readonly prompt: string;
  readonly size?: string;
}): Promise<ImageGenerationResult> {
  if (!args.prompt.trim()) {
    return { success: false, prompt: args.prompt, error: "Prompt is required" };
  }

  if (imageQueue.length >= MAX_QUEUE_SIZE) {
    return {
      success: false,
      prompt: args.prompt,
      error: "Image generation queue is full. Please try again in a moment.",
    };
  }

  return new Promise<ImageGenerationResult>((resolve, reject) => {
    imageQueue.push({ args, resolve, reject });
    processQueue();
  });
}

// ==============================
// Provider chain execution
// ==============================

/**
 * Execute the provider fallback chain for a single request.
 * Called sequentially by the queue processor.
 */
async function executeImageGeneration(args: {
  readonly prompt: string;
  readonly size?: string;
}): Promise<ImageGenerationResult> {
  const errors: string[] = [];
  const startTime = Date.now();
  console.log(`[IMAGE] routing prompt="${args.prompt.slice(0, 60)}..." providers=${providers.length}`);

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
