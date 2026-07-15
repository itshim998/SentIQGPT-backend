// SentIQ Chat v3 — Z-Image Provider (PRIMARY)
//
// Z-Image model via Pollinations.
// Primary image generation provider for standard/simple prompts.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderRequestContext, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const ZIMAGE_TIMEOUT_MS = 30_000;

export class ZimageProvider implements ImageProvider {
  readonly name = "zimage";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string, signal?: AbortSignal, context?: ImageProviderRequestContext): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "zimage", size, context?.requestKey);
    const base64 = await fetchPollinationsImage(imageUrl, ZIMAGE_TIMEOUT_MS, signal);
    return { base64 };
  }
}
