import type { BillingPlanCode } from "./entitlementTypes";
import { normalizeExecutionMode, type ExecutionMode } from "../orchestrator/executionProfile";
import {
  CLOUDFLARE_MODEL_SCHNELL,
  CLOUDFLARE_MODEL_DREAMSHAPER,
  CLOUDFLARE_MODEL_KLEIN_4B,
} from "../tools/imageGeneration/providers/cloudflareImageProvider";

const RETIRED_KLEIN_9B_CANONICAL = "@cf/black-forest-labs/flux-2-klein-9b";

// Authoritative credit costs per successful model generation
export const IMAGE_MODEL_CREDIT_COSTS: Readonly<Record<string, number>> = Object.freeze({
  [CLOUDFLARE_MODEL_SCHNELL]: 1,
  [CLOUDFLARE_MODEL_DREAMSHAPER]: 1,
  [CLOUDFLARE_MODEL_KLEIN_4B]: 2,
  "openai/gpt-image-2": 8,
  "microsoft/mai-image-2.6": 8,
  "black-forest-labs/flux.1.1-pro": 8,
});

/**
 * Checks whether a given model identifier is Klein 9B or its alias,
 * which is retired from all active routes and must not be routable.
 */
export function isRetiredKlein9B(modelOrProvider?: string | null): boolean {
  if (!modelOrProvider || typeof modelOrProvider !== "string") return false;
  const normalized = modelOrProvider.trim().toLowerCase();
  return (
    normalized === RETIRED_KLEIN_9B_CANONICAL ||
    normalized.includes("klein-9b") ||
    normalized.includes("klein_9b") ||
    normalized.includes("flux-2-klein-9b")
  );
}

/**
 * Get authoritative server-owned credit cost for a successful image generation.
 * Unknown or unrecognized image providers/models MUST NOT silently receive a cheap 1-credit cost.
 * Klein 9B is rejected with an error.
 */
export function getImageModelCreditCost(modelOrProvider?: string | null): number {
  if (!modelOrProvider || !modelOrProvider.trim()) {
    throw new Error("Cannot determine image credit cost without a provider or model identifier.");
  }
  if (isRetiredKlein9B(modelOrProvider)) {
    throw new Error(`Klein 9B (${modelOrProvider}) is retired and not routable.`);
  }

  const normalized = modelOrProvider.trim().toLowerCase();

  // 1 credit models
  if (
    normalized === CLOUDFLARE_MODEL_SCHNELL.toLowerCase() ||
    normalized === "flux" ||
    normalized === "schnell" ||
    normalized === "flux-1-schnell" ||
    normalized === "flux-schnell"
  ) {
    return 1;
  }
  if (normalized === CLOUDFLARE_MODEL_DREAMSHAPER.toLowerCase() || normalized === "dreamshaper" || normalized === "dreamshaper-xl-lightning") {
    return 1;
  }

  // 2 credit models
  if (
    normalized === CLOUDFLARE_MODEL_KLEIN_4B.toLowerCase() ||
    normalized === "black-forest-labs/flux.2-klein-4b" ||
    normalized === "flux-2-klein-4b" ||
    normalized === "klein-4b" ||
    normalized === "klein" ||
    normalized === "zimage" ||
    normalized === "tongyi-mai/z-image-turbo"
  ) {
    return 2;
  }

  // 8 credit models (Pro Intuitive Pollinations chain)
  if (
    normalized === "openai/gpt-image-2" ||
    normalized === "gpt-image-2" ||
    normalized === "gptimage" ||
    normalized === "gptimage-large"
  ) {
    return 8;
  }
  if (normalized === "microsoft/mai-image-2.6" || normalized === "mai-image-2.6") {
    return 8;
  }
  if (
    normalized === "black-forest-labs/flux.1.1-pro" ||
    normalized === "flux.1.1-pro" ||
    normalized === "flux-pro"
  ) {
    return 8;
  }

  // Exact lookup in table
  if (IMAGE_MODEL_CREDIT_COSTS[modelOrProvider] !== undefined) {
    return IMAGE_MODEL_CREDIT_COSTS[modelOrProvider];
  }

  throw new Error(
    `Unrecognized image model or provider: "${modelOrProvider}". Unrecognized models cannot receive arbitrary credit costs.`,
  );
}

/**
 * Determines the maximum credit cost of the selected plan/mode fallback chain.
 * The billing reservation MUST reflect this maximum cost so that any fallback can succeed.
 *
 * Matrix:
 * - Free Fast (Schnell 1 -> Dreamshaper 1): max = 1
 * - Free Intuitive (Schnell 1 -> Dreamshaper 1): max = 1
 * - Essential Fast (Schnell 1 -> Klein 4B 2): max = 2
 * - Essential Intuitive (Klein 4B 2 -> Schnell 1): max = 2
 * - Plus Fast (Schnell 1 -> Klein 4B 2): max = 2
 * - Plus Intuitive (Klein 4B 2 -> Schnell 1): max = 2
 * - Pro Fast (Schnell 1 -> Klein 4B 2): max = 2
 * - Pro Intuitive (GPT-Image-2 8 -> MAI-Image-2.6 8 -> FLUX 1.1 Pro 8): max = 8
 */
export function getImageReservationCredits(
  planCode: BillingPlanCode,
  executionMode?: ExecutionMode | string,
): number {
  const mode = normalizeExecutionMode(executionMode);
  if (planCode === "free") {
    return 1;
  }
  if (planCode === "student_core" || planCode === "premium") {
    return 2;
  }
  if (planCode === "pro") {
    return mode === "intuitive" ? 8 : 2;
  }
  return 1;
}
