// SentIQGPT v2 — Pollinations Shared Utilities
//
// Common helpers for all Pollinations-based image providers.
// Handles prompt enhancement, URL construction, and authenticated image fetching.
//
// Reads API key from POLLINATIONS_API_KEY (preferred) or FLUX_API_KEY (legacy).
// The key is sent as:
//   1. Authorization: Bearer <key>  header  (primary — registered by dashboard)
//   2. &token=<key>                 query param (backup)
//
// Without a key, Pollinations free tier is used (strict rate limits → 429).

const QUALITY_SUFFIX = "cinematic lighting, ultra detailed, sharp focus, 8k";

/**
 * Get the Pollinations API key from environment.
 * Checks POLLINATIONS_API_KEY first, falls back to FLUX_API_KEY.
 */
export function getPollinationsApiKey(): string | undefined {
  return process.env.POLLINATIONS_API_KEY || process.env.FLUX_API_KEY || undefined;
}

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
 * Includes the API key as a token query param (backup auth).
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

  const apiKey = getPollinationsApiKey();
  if (apiKey) {
    url += `&token=${encodeURIComponent(apiKey)}`;
  }

  return url;
}

/**
 * Download a Pollinations image via GET and return it as base64.
 * Sends the API key as an Authorization header (primary auth method)
 * and as a query param in the URL (backup).
 */
export async function fetchPollinationsImage(
  imageUrl: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {};
  const apiKey = getPollinationsApiKey();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  console.log(`[POLLINATIONS] request url=${imageUrl.slice(0, 120)}... auth=${!!apiKey}`);

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      headers,
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
