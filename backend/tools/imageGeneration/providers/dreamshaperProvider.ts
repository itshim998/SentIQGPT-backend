// SentIQ Chat — DreamShaper image provider
//
// DreamShaper via Pollinations. Used as the Free-plan primary image model.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderRequestContext, ImageProviderResult } from "../types";
import {
  enhancePrompt,
  buildPollinationsUrl,
  fetchPollinationsImage,
  getPollinationsApiKey,
} from "../pollinationsUtils";

const DREAMSHAPER_TIMEOUT_MS = 30_000;

export class DreamshaperProvider implements ImageProvider {
  readonly name = "dreamshaper";

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(
    prompt: string,
    size?: string,
    signal?: AbortSignal,
    context?: ImageProviderRequestContext,
  ): Promise<ImageProviderResult> {
    const enhanced = enhancePrompt(prompt);
    const imageUrl = buildPollinationsUrl(
      enhanced,
      "dreamshaper",
      size,
      context?.requestKey,
    );
    const base64 = await fetchPollinationsImage(
      imageUrl,
      DREAMSHAPER_TIMEOUT_MS,
      signal,
    );
    return { base64 };
  }
}
