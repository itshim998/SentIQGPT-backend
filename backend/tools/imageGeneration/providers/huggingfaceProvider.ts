// SentIQ Chat v2 — HuggingFace Image Provider
//
// Uses the HuggingFace Inference API with Stable Diffusion XL.
// Requires HUGGINGFACE_API_TOKEN in environment.
// Returns the image as base64.

import type { ImageProvider, ImageProviderResult } from "../types";

const HF_MODEL = "stabilityai/stable-diffusion-xl-base-1.0";
const HF_TIMEOUT_MS = 60_000;

export class HuggingFaceProvider implements ImageProvider {
  readonly name = "huggingface";

  isAvailable(): boolean {
    return Boolean(process.env.HUGGINGFACE_API_TOKEN);
  }

  async generate(prompt: string): Promise<ImageProviderResult> {
    const token = process.env.HUGGINGFACE_API_TOKEN;
    if (!token) {
      throw new Error("HUGGINGFACE_API_TOKEN not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);

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
        const errText = await response.text();
        throw new Error(`HuggingFace returned ${response.status}: ${errText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return { base64 };
    } finally {
      clearTimeout(timeout);
    }
  }
}
