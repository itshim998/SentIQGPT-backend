// SentIQGPT v2 — Pollinations Shared Utilities
//
// Common helpers for all Pollinations-based image providers.
// Handles prompt enhancement, URL construction, and reachability verification.
//
// FLUX_API_KEY (optional) — If set, passed to Pollinations for premium/priority access.
// The API works without a key (free tier), but providing one unlocks higher limits.

const QUALITY_SUFFIX = "cinematic lighting, ultra detailed, sharp focus, 8k";

/**
 * Enhance a user prompt with quality modifiers.
 * Only adds the suffix if the prompt doesn't already contain quality keywords.
 */
export function enhancePrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  const alreadyEnhanced =
    lower.includes("8k") ||
    lower.includes("ultra detailed") ||
    lower.includes("cinematic lighting");
  return alreadyEnhanced ? prompt : `${prompt}, ${QUALITY_SUFFIX}`;
}

/**
 * Build a Pollinations image URL for the given model.
 */
export function buildPollinationsUrl(
  prompt: string,
  model: string,
  size?: string,
): string {
  const [width, height] = (size || "1024x1024").split("x").map(Number);
  const encoded = encodeURIComponent(prompt);

  let url =
    `https://image.pollinations.ai/prompt/${encoded}` +
    `?model=${encodeURIComponent(model)}` +
    `&width=${width || 1024}&height=${height || 1024}` +
    `&nologo=true&seed=${Date.now()}`;

  // FLUX_API_KEY required here — appended as token if configured
  const fluxKey = process.env.FLUX_API_KEY;
  if (fluxKey) {
    url += `&token=${encodeURIComponent(fluxKey)}`;
  }

  return url;
}

/**
 * Download a Pollinations image via GET and return it as base64.
 * Using GET instead of HEAD avoids double-hitting the API (HEAD triggers generation,
 * then the browser's GET triggers it again), which causes 429 rate limits.
 */
export async function fetchPollinationsImage(
  imageUrl: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Pollinations returned HTTP ${response.status}`);
    }

    // Verify the response is actually an image
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`Expected image content-type, got: ${contentType}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  } finally {
    clearTimeout(timer);
  }
}
