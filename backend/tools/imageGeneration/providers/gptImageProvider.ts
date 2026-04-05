// SentIQGPT v2 - GPTImage Provider
//
// wan-image model via Pollinations.
// Used for complex prompts requiring spatial reasoning, text rendering,
// or multi-element composition.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderResult } from "../types";
import { buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const GPTIMAGE_TIMEOUT_MS = 60_000;

export class GptImageProvider implements ImageProvider {
  readonly name = "wan-image";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string): Promise<ImageProviderResult> {
    // Keep complex prompts unchanged so the model receives the full instruction verbatim.
    const imageUrl = buildPollinationsUrl(prompt, "wan-image", size);
    const base64 = await fetchPollinationsImage(imageUrl, GPTIMAGE_TIMEOUT_MS);
    return { base64 };
  }
}
