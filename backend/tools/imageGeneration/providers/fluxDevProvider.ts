// SentIQGPT v2 — FLUX.2 Dev Image Provider (FALLBACK)
//
// FLUX.2 Dev model via Pollinations.
// First fallback if Flux Schnell fails. Higher quality, slightly slower.
//
// FLUX_API_KEY (optional) — passed via pollinationsUtils.buildPollinationsUrl()
// Works without a key on free tier; key enables premium/priority access.

import type { ImageProvider, ImageProviderResult } from "../types";
import { enhancePrompt, buildPollinationsUrl, fetchPollinationsImage } from "../pollinationsUtils";

const FLUX_DEV_TIMEOUT_MS = 45_000;

export class FluxDevProvider implements ImageProvider {
  readonly name = "flux-dev";

  isAvailable(): boolean {
    return true;
  }

  async generate(prompt: string, size?: string): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(enhanced, "flux-dev", size);
    const base64 = await fetchPollinationsImage(imageUrl, FLUX_DEV_TIMEOUT_MS);
    return { base64 };
  }
}
