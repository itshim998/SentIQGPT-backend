// SentIQ Chat v2 — Stability AI Image Provider
//
// Uses the Stability AI REST API (v1 generation endpoint).
// Requires STABILITY_API_KEY in environment.
// Returns the image as base64.

import {
  ImageProviderFailure,
  failureOutcomeForHttpStatus,
  type ImageProvider,
  type ImageProviderResult,
} from "../types";

const STABILITY_ENGINE = "stable-diffusion-xl-1024-v1-0";
const STABILITY_TIMEOUT_MS = 60_000;

/** Map friendly size strings to width/height. */
function parseDimensions(size?: string): { width: number; height: number } {
  switch (size) {
    case "256x256":
      return { width: 512, height: 512 }; // min 512 for SDXL
    case "512x512":
      return { width: 512, height: 512 };
    case "1024x1024":
      return { width: 1024, height: 1024 };
    default:
      return { width: 1024, height: 1024 };
  }
}

export class StabilityProvider implements ImageProvider {
  readonly name = "stability";

  isAvailable(): boolean {
    return Boolean(process.env.STABILITY_API_KEY);
  }

  async generate(prompt: string, size?: string, signal?: AbortSignal): Promise<ImageProviderResult> {
    const apiKey = process.env.STABILITY_API_KEY;
    if (!apiKey) {
      throw new Error("STABILITY_API_KEY not configured");
    }

    const { width, height } = parseDimensions(size);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STABILITY_TIMEOUT_MS);
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      const response = await fetch(
        `https://api.stability.ai/v1/generation/${STABILITY_ENGINE}/text-to-image`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            text_prompts: [{ text: prompt, weight: 1 }],
            cfg_scale: 7,
            width,
            height,
            steps: 30,
            samples: 1,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new ImageProviderFailure(
          `Stability AI returned HTTP ${response.status}`,
          failureOutcomeForHttpStatus(response.status),
          response.status,
        );
      }

      const data = (await response.json()) as {
        artifacts: { base64: string; finishReason: string }[];
      };

      const artifact = data.artifacts?.[0];
      if (!artifact?.base64) {
        throw new ImageProviderFailure("Stability AI returned no image data", "indeterminate");
      }

      return { base64: artifact.base64 };
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted");
      }
      if (error instanceof ImageProviderFailure) throw error;
      throw new ImageProviderFailure(
        controller.signal.aborted ? "Stability AI request timed out" : "Stability AI transport or response read failed",
        "indeterminate",
        undefined,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }
}
