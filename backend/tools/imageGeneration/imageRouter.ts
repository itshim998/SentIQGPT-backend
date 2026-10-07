// SentIQ Chat v3 - Image Router
//
// Plan/mode-based image router with sequential fallback chains, fair in-process
// queue, per-user limits, bounded concurrency, AbortSignal support, and retry logic.
//
// Exact Production Policy:
//   Cloudflare Workers AI is the PRIMARY family for:
//     - Free (Fast & Intuitive): Schnell -> Dreamshaper
//     - Essential Fast:         Schnell -> Klein 4B
//     - Essential Intuitive:    Klein 4B -> Schnell
//     - Plus Fast:              Schnell -> Klein 4B
//     - Plus Intuitive:         Klein 4B -> Schnell
//     - Pro Fast:               Schnell -> Klein 4B
//   Pollinations is used ONLY for:
//     - Pro Intuitive:          GPT-Image-2 -> MAI-Image-2.6 -> FLUX 1.1 Pro
//
// CRITICAL POLICY RULES:
//   - Klein 9B must no longer be used by any active plan/mode.
//   - Pollinations MUST NOT be used by: Free, Essential, Plus, Pro Fast.
//   - Cloudflare MUST NOT be used by: Pro Intuitive.
//   - Each Cloudflare model pool exhausts all healthy configured accounts before
//     advancing to the next model in the fallback chain.

import { createHash } from "node:crypto";
import {
  ImageProviderFailure,
  asImageProviderFailure,
  type ImageModelPreference,
  type ImageProvider,
  type ImageGenerationResult,
  type ImageProviderRequestContext,
} from "./types";
import {
  CloudflareImageProvider,
  CLOUDFLARE_MODEL_SCHNELL,
  CLOUDFLARE_MODEL_KLEIN_4B,
  CLOUDFLARE_MODEL_KLEIN_9B,
  CLOUDFLARE_MODEL_DREAMSHAPER,
} from "./providers/cloudflareImageProvider";
import { PollinationsImageModelProvider } from "./providers/pollinationsImageModelProvider";
import { isRetiredKlein9B } from "../../billing/imageCreditPolicy";
import { DreamshaperProvider } from "./providers/dreamshaperProvider";
import { ZimageProvider } from "./providers/zimageProvider";
import { FluxSchnellProvider } from "./providers/fluxSchnellProvider";
import { PollinationsProvider } from "./providers/pollinationsProvider";
import { HuggingFaceProvider } from "./providers/huggingfaceProvider";
import type { BillingPlanCode } from "../../billing/entitlementTypes";
import { normalizeExecutionMode, type ExecutionMode } from "../../orchestrator/executionProfile";

export type { ImageModelPreference } from "./types";

// ==============================
// Provider chains per plan & mode
// ==============================

/**
 * Construct the canonical provider fallback chain for the given plan code and execution mode.
 */
export function getProvidersForPlanAndMode(
  planCode: BillingPlanCode,
  executionMode: ExecutionMode | string = "fast",
): readonly ImageProvider[] {
  const mode = normalizeExecutionMode(executionMode);

  if (planCode === "free") {
    // Free (both Fast and Intuitive): Schnell pool -> DreamShaper pool
    return [
      new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      new CloudflareImageProvider(CLOUDFLARE_MODEL_DREAMSHAPER),
    ];
  }

  if (planCode === "student_core") {
    if (mode === "intuitive") {
      // Essential Intuitive: Klein 4B pool -> Schnell pool
      return [
        new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B),
        new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      ];
    }
    // Essential Fast: Schnell pool -> Klein 4B pool
    return [
      new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B),
    ];
  }

  if (planCode === "premium") {
    if (mode === "intuitive") {
      // Plus Intuitive: Klein 4B pool -> Schnell pool
      return [
        new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B),
        new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      ];
    }
    // Plus Fast: Schnell pool -> Klein 4B pool
    return [
      new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B),
    ];
  }

  if (planCode === "pro") {
    if (mode === "intuitive") {
      // Pro Intuitive: Pollinations GPT-Image-2 -> MAI-Image-2.6 -> FLUX 1.1 Pro
      return [
        new PollinationsImageModelProvider("openai/gpt-image-2"),
        new PollinationsImageModelProvider("microsoft/mai-image-2.6"),
        new PollinationsImageModelProvider("black-forest-labs/flux.1.1-pro"),
      ];
    }
    // Pro Fast: Schnell pool -> Klein 4B pool
    return [
      new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B),
    ];
  }

  // Fallback safe default: Free Fast chain
  return [
    new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
    new CloudflareImageProvider(CLOUDFLARE_MODEL_DREAMSHAPER),
  ];
}

/**
 * Resolve provider chain from preferred model when plan code is not explicitly supplied.
 */
export function getProvidersForModelPreference(
  preferredModel?: ImageModelPreference,
): readonly ImageProvider[] {
  if (preferredModel && isRetiredKlein9B(preferredModel)) {
    throw new Error(`Klein 9B (${preferredModel}) is retired and not routable.`);
  }
  switch (preferredModel) {
    case "openai/gpt-image-2":
    case "microsoft/mai-image-2.6":
    case "black-forest-labs/flux.1.1-pro":
      return [
        new PollinationsImageModelProvider("openai/gpt-image-2"),
        new PollinationsImageModelProvider("microsoft/mai-image-2.6"),
        new PollinationsImageModelProvider("black-forest-labs/flux.1.1-pro"),
      ];

    case CLOUDFLARE_MODEL_KLEIN_4B:
    case "black-forest-labs/flux.2-klein-4b":
    case "klein":
    case "zimage":
    case "tongyi-mai/z-image-turbo":
      return [
        new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B),
        new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      ];

    case CLOUDFLARE_MODEL_DREAMSHAPER:
    case "dreamshaper":
      return [
        new CloudflareImageProvider(CLOUDFLARE_MODEL_DREAMSHAPER),
        new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
      ];

    case CLOUDFLARE_MODEL_SCHNELL:
    case "flux":
    default:
      return [
        new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL),
        new CloudflareImageProvider(CLOUDFLARE_MODEL_DREAMSHAPER),
      ];
  }
}

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
 * Detect whether a prompt requests complex imagery (text, spatial composition, etc.).
 * Retained for logging and diagnostics; plan entitlement remains authoritative.
 */
export function detectPromptComplexity(prompt: string): boolean {
  let matchCount = 0;
  for (const pattern of COMPLEXITY_PATTERNS) {
    if (pattern.test(prompt)) matchCount++;
  }
  return matchCount >= 1;
}

export function selectImageProviderMode(
  prompt: string,
  preferredModel?: ImageModelPreference,
): "standard" | "complex" {
  if (detectPromptComplexity(prompt)) {
    return "complex";
  }
  return preferredModel === "wan-image"
    || preferredModel === "gptimage"
    || preferredModel === "gptimage-large"
    || preferredModel === "tongyi-mai/z-image-turbo"
    || preferredModel === "black-forest-labs/flux.2-klein-4b"
    || preferredModel === "kontext"
    ? "complex"
    : "standard";
}

/**
 * Returns the ordered names of providers in the chain for diagnostics and tests.
 */
export function getImageProviderOrder(
  prompt: string,
  preferredModel?: ImageModelPreference,
  planCode?: BillingPlanCode,
  executionMode?: ExecutionMode | string,
): readonly string[] {
  let providers: readonly ImageProvider[];
  if (planCode) {
    providers = getProvidersForPlanAndMode(planCode, executionMode ?? "fast");
  } else if (preferredModel) {
    providers = getProvidersForModelPreference(preferredModel);
  } else {
    providers = getProvidersForPlanAndMode("free", "fast");
  }
  return providers.map((p) => p.name);
}

// ==============================
// Per-provider cooldown tracking
// ==============================

const COOLDOWN_MS = 30_000;
const providerCooldownUntil: Map<string, number> = new Map();

function isOnCooldown(name: string): boolean {
  const until = providerCooldownUntil.get(name);
  if (!until) return false;
  if (Date.now() >= until) {
    providerCooldownUntil.delete(name);
    return false;
  }
  return true;
}

function setCooldown(name: string): void {
  providerCooldownUntil.set(name, Date.now() + COOLDOWN_MS);
}

// ==============================
// Helpers
// ==============================

function is429(err: unknown): boolean {
  if (err instanceof ImageProviderFailure && err.statusCode === 429) return true;
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

export interface RouteImageGenerationArgs {
  readonly prompt: string;
  readonly size?: string;
  readonly userId?: string;
  readonly signal?: AbortSignal;
  readonly preferredModel?: ImageModelPreference;
  readonly provider?: "cloudflare" | "pollinations";
  readonly planCode?: BillingPlanCode;
  readonly executionMode?: ExecutionMode | string;
  readonly requestKey?: string;
  readonly providers?: readonly ImageProvider[];
}

interface QueueItem {
  args: RouteImageGenerationArgs;
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
export async function routeImageGeneration(
  args: RouteImageGenerationArgs,
): Promise<ImageGenerationResult> {
  if (!args.prompt.trim()) {
    return { success: false, prompt: args.prompt, error: "Prompt is required" };
  }
  if (args.signal?.aborted) {
    throwIfAborted(args.signal);
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
async function executeImageGeneration(
  args: RouteImageGenerationArgs,
): Promise<ImageGenerationResult> {
  throwIfAborted(args.signal);
  const errors: string[] = [];
  const startTime = Date.now();
  const providerMode = selectImageProviderMode(args.prompt, args.preferredModel);

  const selectedProviders: readonly ImageProvider[] = args.providers ?? (
    args.planCode
      ? getProvidersForPlanAndMode(args.planCode, args.executionMode ?? "fast")
      : getProvidersForModelPreference(args.preferredModel)
  );

  const requestKey = args.requestKey?.trim() || createHash("sha256")
    .update(args.userId?.trim() || "anonymous")
    .update("\0")
    .update(args.size || "1024x1024")
    .update("\0")
    .update(args.prompt)
    .digest("hex");

  console.log(
    `[IMAGE] routing mode=${providerMode} preferred=${args.preferredModel ?? "none"} primary=${selectedProviders[0]?.name ?? "none"} providers=${selectedProviders.length}`,
  );

  for (const provider of selectedProviders) {
    throwIfAborted(args.signal);
    if (!provider.isAvailable()) {
      console.log(`[IMAGE] provider=${provider.name} skipped reason=not_configured`);
      errors.push(`${provider.name}: not configured`);
      continue;
    }

    if (isOnCooldown(provider.name)) {
      console.log(`[IMAGE] provider=${provider.name} skipped reason=cooldown`);
      errors.push(`${provider.name}: on cooldown`);
      continue;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[IMAGE] provider=${provider.name} attempt=${attempt}`);
        const result = await provider.generate(
          args.prompt,
          args.size,
          args.signal,
          { requestKey },
        );
        throwIfAborted(args.signal);
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
        throwIfAborted(args.signal);
        const failure = asImageProviderFailure(err);
        const message = err instanceof Error ? err.message : String(err);

        if (is429(failure) && attempt === 1) {
          console.log(`[IMAGE] provider=${provider.name} got 429, retrying in 1s`);
          await sleep(1000, args.signal);
          continue;
        }

        if (is429(failure)) setCooldown(provider.name);
        console.log(`[IMAGE] provider=${provider.name} failed outcome=${failure.outcome} error="${message}"`);
        errors.push(`${provider.name}: ${message}`);
        break;
      }
    }
  }

  throwIfAborted(args.signal);
  const elapsed = Date.now() - startTime;
  console.log(`[IMAGE] all_providers_failed duration=${elapsed}ms`);
  return {
    success: false,
    prompt: args.prompt,
    error: `All image providers failed. ${errors.join(" | ")}`,
  };
}

/** Offline-test seam for retry-disposition validation. */
export async function executeImageGenerationWithProviders(args: {
  readonly prompt: string;
  readonly size?: string;
  readonly userId?: string;
  readonly signal?: AbortSignal;
  readonly preferredModel?: ImageModelPreference;
  readonly requestKey: string;
  readonly providers: readonly ImageProvider[];
}): Promise<ImageGenerationResult> {
  return executeImageGeneration(args);
}
