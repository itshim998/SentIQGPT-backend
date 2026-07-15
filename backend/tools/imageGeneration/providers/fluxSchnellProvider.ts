// SentIQ Chat v2 — Flux Schnell Image Provider (PRIMARY)
//
// Flux Schnell model via Pollinations.
// Primary image generation provider — fastest FLUX model available.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderRequestContext, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const SCHNELL_TIMEOUT_MS = 30_000;

export class FluxSchnellProvider implements ImageProvider {
  readonly name = "flux";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string, signal?: AbortSignal, context?: ImageProviderRequestContext): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "flux", size, context?.requestKey);
    const base64 = await fetchPollinationsImage(imageUrl, SCHNELL_TIMEOUT_MS, signal);
    return { base64 };
  }
}
