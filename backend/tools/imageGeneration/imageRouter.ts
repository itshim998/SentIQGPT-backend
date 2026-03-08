// SentIQGPT v2 — Image Router
//
// Sequential fallback router for image generation providers.
// Tries each provider in priority order; returns as soon as one succeeds.
//
// Provider chain (Pollinations-first):
//   1. Flux Schnell  (primary — uses FLUX_API_KEY if set)
//   2. FLUX.2 Dev    (fallback — uses FLUX_API_KEY if set)
//   3. Z-Image Turbo (secondary fallback — uses FLUX_API_KEY if set)
//   4. HuggingFace   (requires HUGGINGFACE_API_TOKEN)
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
// Router
// ==============================

/**
 * Route an image generation request through the provider chain.
 *
 * Iterates providers in priority order. For each:
 *   1. Check `isAvailable()` — skip if credentials are missing.
 *   2. Call `generate()` — return on success, catch and continue on failure.
 *
 * Returns a unified `ImageGenerationResult` regardless of which provider
 * fulfilled the request.
 */
export async function routeImageGeneration(args: {
  readonly prompt: string;
  readonly size?: string;
}): Promise<ImageGenerationResult> {
  if (!args.prompt.trim()) {
    return { success: false, prompt: args.prompt, error: "Prompt is required" };
  }

  const errors: string[] = [];
  // FLUX_API_KEY required here — log whether key is configured
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

    try {
      console.log(`[IMAGE] provider=${provider.name} status=attempting`);
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
      console.log(`[IMAGE] provider=${provider.name} failed error="${message}"`);
      errors.push(`${provider.name}: ${message}`);
      // Continue to next provider
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
