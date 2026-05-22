// SentIQGPT v3 - Image Router
//
// Sequential fallback router with per-provider cooldowns, retry, and queue.
// Tries each provider in priority order; returns as soon as one succeeds.
//
// Provider chain (standard):
//   1. zimage                     (primary - Pollinations CDN)
//   2. HuggingFace SDXL           (requires HUGGINGFACE_API_TOKEN)
//   3. FLUX.2 Dev                 (Pollinations fallback)
//   4. Z-Image Turbo              (Pollinations fallback)
//
// Provider chain (complex):
//   1. wan-image                 (complex prompt primary)
//   2. zimage                     (fallback)
//   3. FLUX.2 Dev                 (fallback)
//   4. HuggingFace SDXL           (fallback)
//   5. Z-Image Turbo              (fallback)
//
// Features:
//   - Fair in-process queue with per-user limits and bounded concurrency
//   - Strictly sequential provider fallback within each request
//   - 30-second cooldown on HTTP 429
//   - 30-45 second timeout per Pollinations attempt
//   - 60-second timeout for HuggingFace (slow inference)
//   - Single retry after 1-second wait on 429
//   - Auth: &key= query parameter on Pollinations requests (gen.pollinations.ai API v2)
//
// Requires POLLINATIONS_API_KEY (or legacy FLUX_API_KEY) for Pollinations providers.
// If ALL providers fail, returns a structured error - never crashes.

import type { ImageProvider, ImageGenerationResult } from "./types";
import { ZimageProvider } from "./providers/zimageProvider";
import { FluxDevProvider } from "./providers/fluxDevProvider";
import { PollinationsProvider } from "./providers/pollinationsProvider";
import { HuggingFaceProvider } from "./providers/huggingfaceProvider";
import { GptImageProvider } from "./providers/gptImageProvider";
import { isChartRequest } from "../chartGeneration/chartDetector";

// ==============================
// Provider registry (order = priority)
// ==============================

// Standard providers (simple/moderate prompts)
const standardProviders: readonly ImageProvider[] = [
  new ZimageProvider(),          // 1. zimage (primary)
  new HuggingFaceProvider(),     // 2. HuggingFace SDXL (fast fallback with API key)
  new FluxDevProvider(),          // 3. Pollinations FLUX.2 Dev
  new PollinationsProvider(),     // 4. Pollinations Z-Image Turbo
];

// Complex providers (text, spatial, multi-element prompts)
const complexProviders: readonly ImageProvider[] = [
  new GptImageProvider(),         // 1. wan-image (complex prompt primary)
  new ZimageProvider(),           // 2. zimage (fallback)
  new FluxDevProvider(),          // 3. FLUX.2 Dev (fallback)
  new HuggingFaceProvider(),      // 4. HuggingFace SDXL (fallback)
  new PollinationsProvider(),     // 5. Z-Image Turbo (fallback)
];

// ==============================
// Prompt complexity detection
// ==============================

const COMPLEXITY_PATTERNS: readonly RegExp[] = [
  // Text in image
  /\b(?:text|sign|say(?:s|ing)?|word(?:s)?|letter(?:s)?|written|writing|caption|label|banner|slogan|quote)\b/i,
  // Spatial relationships
  /\b(?:holding|carry(?:ing)?|wear(?:ing)?|standing\s+(?:in front of|behind|next to|beside|near))\b/i,
  /\b(?:in front of|behind|next to|on top of|surrounded by|inside|between)\b/i,
  // Multi-element composition
  /\b(?:multiple|several|three|four|five|six|seven|eight|many|group of|crowd)\b/i,
  // Specific poses / actions
  /\b(?:pointing at|looking at|reaching for|sitting on|leaning against)\b/i,
  // Highly detailed scenes
  /\b(?:cinematic scene|photorealistic|hyper.?realistic|ultra.?detailed scene)\b/i,
];

/**
 * Detect whether a prompt requires complex generation (spatial reasoning, text, multi-element).
 * Returns true if the prompt likely benefits from the complex-provider path.
 */
export function detectPromptComplexity(prompt: string): boolean {
  let matchCount = 0;
  for (const pattern of COMPLEXITY_PATTERNS) {
    if (pattern.test(prompt)) matchCount++;
  }
  // Require at least 1 match to route to complex
  return matchCount >= 1;
}

export type ImageModelPreference = "zimage" | "wan-image";

export function selectImageProviderMode(
  prompt: string,
  preferredModel?: ImageModelPreference,
): "standard" | "complex" {
  if (detectPromptComplexity(prompt)) {
    return "complex";
  }
  return preferredModel === "wan-image" ? "complex" : "standard";
}

// ==============================
// Per-provider cooldown tracking
// ==============================

const COOLDOWN_MS = 30_000;
const providerCooldownUntil: Map<string, number> = new Map();

function isOnCooldown(name: string): boolean {
  const until = providerCooldownUntil.get(name);
  if (!until) return false;
  if (Date.now() >= until) { providerCooldownUntil.delete(name); return false; }
  return true;
}

function setCooldown(name: string): void {
  providerCooldownUntil.set(name, Date.now() + COOLDOWN_MS);
}

// ==============================
// Helpers
// ==============================

function is429(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("rate limit");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Image generation aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    function cleanup(): void {
      signal?.removeEventListener("abort", onAbort);
    }
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Image generation aborted"));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ==============================
// Image Generation Queue
// ==============================

const MAX_QUEUE_SIZE = parsePositiveInt(process.env.SENTIQ_IMAGE_QUEUE_MAX, 10);
const MAX_QUEUE_SIZE_PER_USER = parsePositiveInt(process.env.SENTIQ_IMAGE_QUEUE_MAX_PER_USER, 3);
const MAX_CONCURRENT_JOBS = parsePositiveInt(process.env.SENTIQ_IMAGE_QUEUE_CONCURRENCY, 2);

interface QueueItem {
  args: {
    readonly prompt: string;
    readonly size?: string;
    readonly userId?: string;
    readonly signal?: AbortSignal;
    readonly preferredModel?: ImageModelPreference;
  };
  userKey: string;
  resolve: (result: ImageGenerationResult) => void;
  reject: (err: Error) => void;
  abortListener?: () => void;
}

const imageQueuesByUser: Map<string, QueueItem[]> = new Map();
const readyUserKeys: string[] = [];
let activeImageJobs = 0;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getQueueUserKey(userId?: string): string {
  const normalized = typeof userId === "string" ? userId.trim() : "";
  return normalized && normalized !== "guest" ? `user:${normalized}` : "anonymous";
}

function getTotalQueuedJobs(): number {
  let total = 0;
  for (const queue of imageQueuesByUser.values()) {
    total += queue.length;
  }
  return total;
}

function enqueueUserIfReady(userKey: string): void {
  if (!readyUserKeys.includes(userKey) && (imageQueuesByUser.get(userKey)?.length ?? 0) > 0) {
    readyUserKeys.push(userKey);
  }
}

function removeQueuedItem(item: QueueItem): boolean {
  const queue = imageQueuesByUser.get(item.userKey);
  if (!queue) return false;
  const index = queue.indexOf(item);
  if (index < 0) return false;
  queue.splice(index, 1);
  if (queue.length === 0) {
    imageQueuesByUser.delete(item.userKey);
  }
  return true;
}

function takeNextQueuedItem(): QueueItem | null {
  while (readyUserKeys.length > 0) {
    const userKey = readyUserKeys.shift()!;
    const queue = imageQueuesByUser.get(userKey);
    if (!queue || queue.length === 0) {
      imageQueuesByUser.delete(userKey);
      continue;
    }
    const item = queue.shift()!;
    if (queue.length > 0) {
      readyUserKeys.push(userKey);
    } else {
      imageQueuesByUser.delete(userKey);
    }
    return item;
  }
  return null;
}

function processQueue(): void {
  while (activeImageJobs < MAX_CONCURRENT_JOBS) {
    const item = takeNextQueuedItem();
    if (!item) return;

    activeImageJobs += 1;
    if (item.abortListener) {
      item.args.signal?.removeEventListener("abort", item.abortListener);
    }

    void executeImageGeneration(item.args)
      .then(item.resolve, (err) => item.reject(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        activeImageJobs = Math.max(0, activeImageJobs - 1);
        processQueue();
      });
  }
}

// ==============================
// Router (public entry point)
// ==============================

/**
 * Route an image generation request through the fair in-process queue and provider chain.
 */
export async function routeImageGeneration(args: {
  readonly prompt: string;
  readonly size?: string;
  readonly userId?: string;
  readonly signal?: AbortSignal;
  readonly preferredModel?: ImageModelPreference;
}): Promise<ImageGenerationResult> {
  if (!args.prompt.trim()) {
    return { success: false, prompt: args.prompt, error: "Prompt is required" };
  }
  if (args.signal?.aborted) {
    throwIfAborted(args.signal);
  }

  // Hard safety rule: chart/data-visualization prompts must NEVER reach image
  // generation models.  Reject immediately and guide the caller to chartGeneration.
  if (isChartRequest(args.prompt)) {
    console.warn(`[IMAGE ROUTER] chart request blocked - prompt="${args.prompt.slice(0, 60)}..."`);
    return {
      success: false,
      prompt: args.prompt,
      error:
        "Chart and data visualization requests must be handled by the chartGeneration tool, " +
        "not by image generation models. Please use /api/charts/generate instead.",
    };
  }

  const userKey = getQueueUserKey(args.userId);
  const userQueue = imageQueuesByUser.get(userKey) ?? [];

  if (getTotalQueuedJobs() >= MAX_QUEUE_SIZE) {
    return {
      success: false,
      prompt: args.prompt,
      error: "Image generation queue is full. Please try again in a moment.",
    };
  }
  if (userQueue.length >= MAX_QUEUE_SIZE_PER_USER) {
    return {
      success: false,
      prompt: args.prompt,
      error: "Image generation queue is full for this account. Please wait for an existing image request to finish.",
    };
  }

  return new Promise<ImageGenerationResult>((resolve, reject) => {
    const item: QueueItem = { args, userKey, resolve, reject };
    if (args.signal) {
      item.abortListener = () => {
        if (removeQueuedItem(item)) {
          reject(args.signal?.reason instanceof Error ? args.signal.reason : new Error("Image generation aborted"));
        }
      };
      args.signal.addEventListener("abort", item.abortListener, { once: true });
    }
    userQueue.push(item);
    imageQueuesByUser.set(userKey, userQueue);
    enqueueUserIfReady(userKey);
    processQueue();
  });
}

// ==============================
// Provider chain execution
// ==============================

/**
 * Execute the provider fallback chain for a single request.
 * Called sequentially by the queue processor.
 */
async function executeImageGeneration(args: {
  readonly prompt: string;
  readonly size?: string;
  readonly signal?: AbortSignal;
  readonly preferredModel?: ImageModelPreference;
}): Promise<ImageGenerationResult> {
  throwIfAborted(args.signal);
  const errors: string[] = [];
  const startTime = Date.now();
  const providerMode = selectImageProviderMode(args.prompt, args.preferredModel);
  const selectedProviders = providerMode === "complex" ? complexProviders : standardProviders;
  console.log(
    `[IMAGE] routing prompt="${args.prompt.slice(0, 60)}..." mode=${providerMode} preferred=${args.preferredModel ?? "none"} primary=${selectedProviders[0]?.name ?? "none"} providers=${selectedProviders.length}`,
  );

  for (const provider of selectedProviders) {
    throwIfAborted(args.signal);
    // Skip unavailable providers (missing API keys, etc.)
    if (!provider.isAvailable()) {
      console.log(`[IMAGE] provider=${provider.name} skipped reason=not_configured`);
      errors.push(`${provider.name}: not configured`);
      continue;
    }

    // Skip providers on cooldown from recent 429
    if (isOnCooldown(provider.name)) {
      console.log(`[IMAGE] provider=${provider.name} skipped reason=cooldown`);
      errors.push(`${provider.name}: on cooldown`);
      continue;
    }

    // Attempt with optional single retry on 429
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[IMAGE] provider=${provider.name} attempt=${attempt}`);
        const result = await provider.generate(args.prompt, args.size);
        const elapsed = Date.now() - startTime;
        console.log(`[IMAGE] provider=${provider.name} success duration=${elapsed}ms`);
        return {
          success: true,
          image_url: result.url,
          image_base64: result.base64,
          provider_used: provider.name,
          prompt: args.prompt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (is429(err) && attempt === 1) {
          console.log(`[IMAGE] provider=${provider.name} got 429, retrying in 1s`);
          await sleep(1000, args.signal);
          continue; // retry once
        }

        // Final failure for this provider
        if (is429(err)) setCooldown(provider.name);
        console.log(`[IMAGE] provider=${provider.name} failed error="${message}"`);
        errors.push(`${provider.name}: ${message}`);
        break; // move to next provider
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[IMAGE] all_providers_failed duration=${elapsed}ms`);
  return {
    success: false,
    prompt: args.prompt,
    error: `All image providers failed. ${errors.join(" | ")}`,
  };
}
