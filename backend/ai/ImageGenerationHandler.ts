import { URL } from "url";

// SentIQ Chat v1 — Image Generation Handler
//
// Multi-provider image generation with automatic fallback.
// Providers: Pollinations AI → HuggingFace Inference API → fallback
//
// Mirrors the key rotation pattern from llm_adapter.py.

export interface ImageGenerationResult {
  readonly success: boolean;
  readonly image_url?: string;
  readonly image_base64?: string;
  readonly provider_used?: string;
  readonly prompt: string;
  readonly error?: string;
}

interface ImageProvider {
  readonly name: string;
  generate(prompt: string, size?: string): Promise<{ url?: string; base64?: string }>;
}

// ==============================
// Provider 1: Pollinations AI (free, no auth)
// ==============================

class PollinationsProvider implements ImageProvider {
  readonly name = "pollinations";

  async generate(prompt: string): Promise<{ url?: string }> {
    const encoded = encodeURIComponent(prompt);
    // Pollinations returns the image directly at this URL
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}`;

    // Verify the URL is reachable
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(imageUrl, {
        method: "HEAD",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Pollinations returned ${response.status}`);
      }

      return { url: imageUrl };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ==============================
// Provider 2: HuggingFace Inference API
// ==============================

class HuggingFaceProvider implements ImageProvider {
  readonly name = "huggingface";

  async generate(prompt: string): Promise<{ base64?: string }> {
    const token = process.env.HUGGINGFACE_API_TOKEN;
    if (!token) {
      throw new Error("HUGGINGFACE_API_TOKEN not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(
        "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inputs: prompt }),
          signal: controller.signal,
        }
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

// ==============================
// Provider registry
// ==============================

const providers: ImageProvider[] = [
  new PollinationsProvider(),
  new HuggingFaceProvider(),
];

// ==============================
// Multi-provider fallback router
// ==============================

export async function generateImage(args: {
  readonly prompt: string;
  readonly size?: string;
}): Promise<ImageGenerationResult> {
  if (!args.prompt.trim()) {
    return { success: false, prompt: args.prompt, error: "Prompt is required" };
  }

  let lastError: string | undefined;

  for (const provider of providers) {
    try {
      const result = await provider.generate(args.prompt, args.size);

      return {
        success: true,
        image_url: result.url,
        image_base64: result.base64,
        provider_used: provider.name,
        prompt: args.prompt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = `${provider.name}: ${message}`;
      // Continue to next provider
    }
  }

  return {
    success: false,
    prompt: args.prompt,
    error: `All image providers failed. Last error: ${lastError}`,
  };
}
