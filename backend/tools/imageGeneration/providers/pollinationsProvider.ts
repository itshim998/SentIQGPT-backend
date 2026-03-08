// SentIQGPT v2 — Z-Image Turbo Provider (SECONDARY FALLBACK)
//
// Z-Image Turbo model via Pollinations.
// Secondary fallback if both Flux Schnell and FLUX.2 Dev fail.
//
// FLUX_API_KEY (optional) — passed via pollinationsUtils.buildPollinationsUrl()
// Works without a key on free tier; key enables premium/priority access.

import type { ImageProvider, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, verifyPollinationsUrl } from "../pollinationsUtils";

const TURBO_TIMEOUT_MS = 20_000;

export class PollinationsProvider implements ImageProvider {
  readonly name = "z-image-turbo";

  // FLUX_API_KEY required here — checked at URL build time in pollinationsUtils
  isAvailable(): boolean {
    return true;
  }

  async generate(prompt: string, size?: string): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "turbo", size);
    await verifyPollinationsUrl(imageUrl, TURBO_TIMEOUT_MS);
    return { url: imageUrl };
  }
}
