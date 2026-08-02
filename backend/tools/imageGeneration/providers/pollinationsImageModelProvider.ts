// Provider-neutral Pollinations image model adapter.
//
// Used when routing needs to instantiate a named Pollinations model directly
// (for example klein, kontext, gpt-image-2, or legacy explicit preferences).
// The model identifier remains visible in provider lifecycle logs and billing
// settlement, while credentials and prompt-bearing URLs remain private.

import type {
  ImageModelPreference,
  ImageProvider,
  ImageProviderRequestContext,
  ImageProviderResult,
} from "../types";
import {
  buildPollinationsUrl,
  enhancePrompt,
  fetchPollinationsImage,
  getPollinationsApiKey,
} from "../pollinationsUtils";

export interface PollinationsImageModelProviderOptions {
  readonly timeoutMs?: number;
  readonly enhance?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class PollinationsImageModelProvider implements ImageProvider {
  readonly name: ImageModelPreference;
  private readonly timeoutMs: number;
  private readonly enhance: boolean;

  constructor(
    modelName: ImageModelPreference,
    options: PollinationsImageModelProviderOptions = {},
  ) {
    this.name = modelName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.enhance = options.enhance ?? false;
  }

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(
    prompt: string,
    size?: string,
    signal?: AbortSignal,
    context?: ImageProviderRequestContext,
  ): Promise<ImageProviderResult> {
    const providerPrompt = this.enhance ? enhancePrompt(prompt) : prompt;
    const imageUrl = buildPollinationsUrl(
      providerPrompt,
      this.name,
      size,
      context?.requestKey,
    );
    const base64 = await fetchPollinationsImage(imageUrl, this.timeoutMs, signal);
    return { base64 };
  }
}
