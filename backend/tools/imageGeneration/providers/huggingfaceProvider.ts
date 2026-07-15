// SentIQ Chat v2 — HuggingFace Image Provider
//
// Uses the HuggingFace Inference API with Stable Diffusion XL.
// Requires HUGGINGFACE_API_TOKEN in environment.
// Returns the image as base64.

import {
  ImageProviderFailure,
  failureOutcomeForHttpStatus,
  type ImageProvider,
  type ImageProviderResult,
} from "../types";

const HF_MODEL = "stabilityai/stable-diffusion-xl-base-1.0";
const HF_TIMEOUT_MS = 60_000;

export class HuggingFaceProvider implements ImageProvider {
  readonly name = "huggingface";

  isAvailable(): boolean {
    return Boolean(process.env.HUGGINGFACE_API_TOKEN);
  }

  async generate(prompt: string, _size?: string, signal?: AbortSignal): Promise<ImageProviderResult> {
    const token = process.env.HUGGINGFACE_API_TOKEN;
    if (!token) {
      throw new Error("HUGGINGFACE_API_TOKEN not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      const response = await fetch(
        `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inputs: prompt }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new ImageProviderFailure(
          `HuggingFace returned HTTP ${response.status}`,
          failureOutcomeForHttpStatus(response.status),
          response.status,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return { base64 };
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted");
      }
      if (error instanceof ImageProviderFailure) throw error;
      throw new ImageProviderFailure(
        controller.signal.aborted ? "HuggingFace request timed out" : "HuggingFace transport or response read failed",
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
