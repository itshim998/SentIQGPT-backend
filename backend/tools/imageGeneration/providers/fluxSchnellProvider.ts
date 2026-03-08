// SentIQGPT v2 — Flux Schnell Image Provider (PRIMARY)
//
// Flux Schnell model via Pollinations.
// Primary image generation provider — fastest FLUX model available.
// Automatically enhances prompts for higher quality output.
//
// FLUX_API_KEY (optional) — passed via pollinationsUtils.buildPollinationsUrl()
// Works without a key on free tier; key enables premium/priority access.

import type { ImageProvider, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, verifyPollinationsUrl } from "../pollinationsUtils";

const SCHNELL_TIMEOUT_MS = 45_000;

export class FluxSchnellProvider implements ImageProvider {
  readonly name = "flux-schnell";

  // FLUX_API_KEY required here — checked at URL build time in pollinationsUtils
  isAvailable(): boolean {
    return true;
  }

  async generate(prompt: string, size?: string): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "flux", size);
    await verifyPollinationsUrl(imageUrl, SCHNELL_TIMEOUT_MS);
    return { url: imageUrl };
  }
}
