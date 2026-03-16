// SentIQGPT v3 — Z-Image Provider (PRIMARY)
//
// Z-Image model via Pollinations.
// Primary image generation provider for standard/simple prompts.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const ZIMAGE_TIMEOUT_MS = 30_000;

export class ZimageProvider implements ImageProvider {
  readonly name = "zimage";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "zimage", size);
    const base64 = await fetchPollinationsImage(imageUrl, ZIMAGE_TIMEOUT_MS);
    return { base64 };
  }
}
