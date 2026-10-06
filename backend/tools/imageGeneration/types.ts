// SentIQ Chat v3 — Image Generation Types
//
// Shared interface and model-preference contract for all image providers and
// every image-routing call site.

export const IMAGE_MODEL_PREFERENCES = Object.freeze([
  "dreamshaper",
  "flux",
  "zimage",
  "klein",
  "gpt-image-2",
  "kontext",
  "wan-image",
  "gptimage",
  "gptimage-large",
  "tongyi-mai/z-image-turbo",
  "black-forest-labs/flux.2-klein-4b",
  // Canonical Cloudflare Workers AI model IDs
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/lykon/dreamshaper-8-lcm",
  // Canonical Pollinations Pro Intuitive model IDs
  "openai/gpt-image-2",
  "microsoft/mai-image-2.6",
  "black-forest-labs/flux.1.1-pro",
] as const);

export type ImageModelPreference = (typeof IMAGE_MODEL_PREFERENCES)[number];

const IMAGE_MODEL_PREFERENCE_SET: ReadonlySet<string> = new Set(
  IMAGE_MODEL_PREFERENCES.map((m) => m.toLowerCase()),
);

export function isImageModelPreference(value: string): value is ImageModelPreference {
  return IMAGE_MODEL_PREFERENCE_SET.has(value.trim().toLowerCase());
}

export function requireImageModelPreference(value: string): ImageModelPreference {
  const normalized = value.trim().toLowerCase();
  if (!isImageModelPreference(normalized)) {
    throw new Error(`Unsupported image model preference: ${value}`);
  }
  return normalized;
}

/**
 * Common result shape returned by every image provider.
 */
export interface ImageProviderResult {
  /** Direct URL to the generated image (if the provider serves one). */
  readonly url?: string;
  /** Base64-encoded image bytes (if the provider returns binary). */
  readonly base64?: string;
}

export type ImageProviderFailureOutcome = "definitive" | "indeterminate";

export class ImageProviderFailure extends Error {
  constructor(
    message: string,
    readonly outcome: ImageProviderFailureOutcome,
    readonly statusCode?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ImageProviderFailure";
  }
}

export interface ImageProviderRequestContext {
  /** Stable across retries and request replays. Never log this value. */
  readonly requestKey: string;
}

export function failureOutcomeForHttpStatus(status: number): ImageProviderFailureOutcome {
  return status >= 400 && status < 500 && status !== 408 ? "definitive" : "indeterminate";
}

export function asImageProviderFailure(error: unknown): ImageProviderFailure {
  if (error instanceof ImageProviderFailure) return error;
  return new ImageProviderFailure(
    error instanceof Error ? error.message : String(error),
    "indeterminate",
    undefined,
    { cause: error },
  );
}

/**
 * Contract every image provider must satisfy.
 *
 * The router iterates providers in priority order, calling `generate()`
 * on each until one succeeds. A provider that cannot fulfil the request
 * should throw — the router catches and moves on.
 */
export interface ImageProvider {
  /** Human-readable provider name used in logs and responses. */
  readonly name: string;
  /** Returns true when the provider has the credentials it needs. */
  isAvailable(): boolean;
  /** Generate an image. Throws on failure. */
  generate(
    prompt: string,
    size?: string,
    signal?: AbortSignal,
    context?: ImageProviderRequestContext,
  ): Promise<ImageProviderResult>;
}

/**
 * Final result returned by the image router to the orchestrator.
 */
export interface ImageGenerationResult {
  readonly success: boolean;
  readonly image_url?: string;
  readonly image_base64?: string;
  readonly provider_used?: string;
  readonly prompt: string;
  readonly error?: string;
}
