// SentIQ Chat v2 - GPTImage Provider
//
// wan-image model via Pollinations.
// Used for complex prompts requiring spatial reasoning, text rendering,
// or multi-element composition.
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) in environment.

import type { ImageProvider, ImageProviderRequestContext, ImageProviderResult } from "../types";
import { buildPollinationsUrl, fetchPollinationsImage, getPollinationsApiKey } from "../pollinationsUtils";

const GPTIMAGE_TIMEOUT_MS = 60_000;

export class GptImageProvider implements ImageProvider {
  readonly name: string;

  constructor(private readonly modelName = readTextImageModel()) {
    this.name = modelName;
  }

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(prompt: string, size?: string, signal?: AbortSignal, context?: ImageProviderRequestContext): Promise<ImageProviderResult> {
    // Keep complex prompts unchanged so the model receives the full instruction verbatim.
    const imageUrl = buildPollinationsUrl(prompt, this.modelName, size, context?.requestKey);
    const base64 = await fetchPollinationsImage(imageUrl, GPTIMAGE_TIMEOUT_MS, signal);
    return { base64 };
  }
}

function readTextImageModel(): string {
  const raw = process.env.SENTIQ_IMAGE_MODEL_TEXT_CORE?.trim() || "pollinations:gptimage";
  const parts = raw.split(":");
  return (parts[parts.length - 1] || "gptimage").trim();
}
