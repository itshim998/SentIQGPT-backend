// SentIQ Chat v2 — FLUX.2 Dev Image Provider (FALLBACK)
//
// FLUX.2 Dev model via Pollinations.
// Higher quality, slightly slower.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const FLUX_DEV_TIMEOUT_MS = 45_000;

export class FluxDevProvider implements ImageProvider {
  readonly name = "flux";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "flux", size);
    const base64 = await fetchPollinationsImage(imageUrl, FLUX_DEV_TIMEOUT_MS);
    return { base64 };
  }
}
