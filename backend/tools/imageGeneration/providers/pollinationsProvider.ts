// SentIQ Chat v2 — Z-Image Turbo Provider (SECONDARY FALLBACK)
//
// Z-Image Turbo model via Pollinations.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderRequestContext, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const TURBO_TIMEOUT_MS = 30_000;

export class PollinationsProvider implements ImageProvider {
  readonly name = "z-image-turbo";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string, signal?: AbortSignal, context?: ImageProviderRequestContext): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "z-image-turbo", size, context?.requestKey);
    const base64 = await fetchPollinationsImage(imageUrl, TURBO_TIMEOUT_MS, signal);
    return { base64 };
  }
}
