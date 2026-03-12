// SentIQGPT v2 — Klein Large Image Provider
//
// Klein-large model via Pollinations.
// Used for complex prompts requiring spatial reasoning, text rendering,
// or multi-element composition. Slower but higher fidelity than Flux.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderResult } from "../types";
import { buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const KLEIN_TIMEOUT_MS = 60_000; // Klein is slower — 60s timeout

export class KleinLargeProvider implements ImageProvider {
  readonly name = "klein-large";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string): Promise<ImageProviderResult> {
    // Do NOT enhance prompt — klein-large handles complex prompts better as-is
    const imageUrl = buildPollinationsUrl(prompt, "klein-large", size);
    const base64 = await fetchPollinationsImage(imageUrl, KLEIN_TIMEOUT_MS);
    return { base64 };
  }
}
