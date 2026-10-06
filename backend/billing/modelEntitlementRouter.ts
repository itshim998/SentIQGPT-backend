import type { BillingPlanCode, BillableFeature } from "./entitlementTypes";
import type { ImageModelPreference } from "../tools/imageGeneration/types";
import { normalizeExecutionMode, type ExecutionMode } from "../orchestrator/executionProfile";

export interface ModelRoute {
  readonly feature: BillableFeature;
  readonly provider: string;
  readonly model: string;
  readonly adapterModelOverride: string;
  readonly safeModelLabel: string;
  readonly route: "standard" | "lite" | "advanced_reasoning" | "image" | "deep_research";
}

export interface ImageModelRoute extends ModelRoute {
  readonly feature: "image_generation";
  readonly provider: "cloudflare" | "pollinations";
  readonly model: ImageModelPreference;
  readonly adapterModelOverride: ImageModelPreference;
  readonly route: "image";
}

function stripProviderPrefix(value: string): { provider: string; model: string } {
  const normalized = value.trim();
  const match = normalized.match(/^([a-z0-9_-]+):(.+)$/i);
  if (!match) {
    return { provider: "", model: normalized };
  }
  return { provider: match[1].toLowerCase(), model: match[2].trim() };
}

function readModel(envName: string, fallback: string): { provider: string; model: string; adapterModelOverride: string } {
  const raw = process.env[envName]?.trim() || fallback;
  const parsed = stripProviderPrefix(raw);
  return {
    provider: parsed.provider || (fallback.startsWith("groq:") ? "groq" : fallback.startsWith("pollinations:") ? "pollinations" : ""),
    model: parsed.model,
    adapterModelOverride: parsed.model,
  };
}

export function getPremiumTextRoute(): ModelRoute {
  const model = readModel("SENTIQ_MODEL_PREMIUM_TEXT", "groq:gpt-oss-120b");
  return {
    feature: "premium_text",
    provider: model.provider || "groq",
    model: model.model,
    adapterModelOverride: model.adapterModelOverride,
    safeModelLabel: "Standard",
    route: "standard",
  };
}

export function getGeminiStandardCapabilityRoute(): ModelRoute {
  return {
    feature: "premium_text",
    provider: "gemini",
    model: "gemini-standard",
    adapterModelOverride: "gemini-standard",
    safeModelLabel: "Standard",
    route: "standard",
  };
}

export function getLiteTextRoute(): ModelRoute {
  const model = readModel("SENTIQ_MODEL_LITE_TEXT", "gemini:gemini-lite");
  return {
    feature: "lite_text",
    provider: model.provider || "pollinations",
    model: model.model,
    adapterModelOverride: model.adapterModelOverride,
    safeModelLabel: "Lite",
    route: "lite",
  };
}

export function getGeminiLiteCapabilityRoute(): ModelRoute {
  return {
    feature: "lite_text",
    provider: "gemini",
    model: "gemini-lite",
    adapterModelOverride: "gemini-lite",
    safeModelLabel: "Lite",
    route: "lite",
  };
}

export function getAdvancedReasoningRoute(): ModelRoute {
  const model = readModel("SENTIQ_MODEL_ADVANCED_REASONING", "groq:gpt-oss-120b");
  return {
    feature: "advanced_reasoning",
    provider: model.provider || "pollinations",
    model: model.model,
    adapterModelOverride: model.adapterModelOverride,
    safeModelLabel: "Advanced reasoning",
    route: "advanced_reasoning",
  };
}

export function getGeminiAdvancedReasoningCapabilityRoute(): ModelRoute {
  return {
    feature: "advanced_reasoning",
    provider: "gemini",
    model: "reasoning",
    adapterModelOverride: "reasoning",
    safeModelLabel: "Advanced reasoning",
    route: "advanced_reasoning",
  };
}

export function getImageModelPreferenceForPlan(
  planCode: BillingPlanCode,
  requiresTextRendering = false,
): ImageModelPreference {
  void requiresTextRendering;
  if (planCode === "free") return "@cf/black-forest-labs/flux-1-schnell";
  if (planCode === "student_core") return "@cf/black-forest-labs/flux-1-schnell";
  if (planCode === "premium") return "@cf/black-forest-labs/flux-2-klein-4b";
  return "@cf/black-forest-labs/flux-2-klein-9b";
}

/**
 * Resolve the image model from the active billing plan and the validated
 * texting-model decision carried by image_gen. Prompt wording is never parsed
 * here, so plan enforcement remains server-owned and deterministic.
 */
export function getImageModelForPlan(
  planCode: BillingPlanCode,
  requiresTextRendering = false,
): ImageModelRoute {
  const model = getImageModelPreferenceForPlan(planCode, requiresTextRendering);
  return {
    feature: "image_generation",
    provider: "cloudflare",
    model,
    adapterModelOverride: model,
    safeModelLabel: planCode === "free" ? "Image" : "Precision Image",
    route: "image",
  };
}

export interface ResolveImageRouteArgs {
  readonly planCode: BillingPlanCode;
  readonly executionMode?: ExecutionMode | string;
  readonly requiresTextRendering?: boolean;
}

/**
 * Resolve the image route accounting for billing plan entitlement, execution mode,
 * and text-rendering decision.
 *
 * Exact production policy matrix:
 * - Free Fast:           Cloudflare Schnell
 * - Free Intuitive:      Cloudflare Schnell
 * - Essential Fast:      Cloudflare Schnell
 * - Essential Intuitive: Cloudflare Klein 4B
 * - Plus Fast:           Cloudflare Klein 4B
 * - Plus Intuitive:      Cloudflare Klein 9B
 * - Pro Fast:            Cloudflare Klein 9B
 * - Pro Intuitive:       Pollinations GPT-Image-2 (openai/gpt-image-2)
 *
 * Prompt complexity or requiresTextRendering must NOT override this entitlement matrix.
 */
export function resolveImageRoute(args: ResolveImageRouteArgs): ImageModelRoute {
  const mode = normalizeExecutionMode(args.executionMode);
  const plan = args.planCode;

  if (plan === "free") {
    const model: ImageModelPreference = "@cf/black-forest-labs/flux-1-schnell";
    return {
      feature: "image_generation",
      provider: "cloudflare",
      model,
      adapterModelOverride: model,
      safeModelLabel: "Image",
      route: "image",
    };
  }

  if (plan === "student_core") {
    const model: ImageModelPreference = mode === "intuitive"
      ? "@cf/black-forest-labs/flux-2-klein-4b"
      : "@cf/black-forest-labs/flux-1-schnell";
    return {
      feature: "image_generation",
      provider: "cloudflare",
      model,
      adapterModelOverride: model,
      safeModelLabel: "Precision Image",
      route: "image",
    };
  }

  if (plan === "premium") {
    const model: ImageModelPreference = mode === "intuitive"
      ? "@cf/black-forest-labs/flux-2-klein-9b"
      : "@cf/black-forest-labs/flux-2-klein-4b";
    return {
      feature: "image_generation",
      provider: "cloudflare",
      model,
      adapterModelOverride: model,
      safeModelLabel: "Precision Image",
      route: "image",
    };
  }

  if (plan === "pro") {
    if (mode === "intuitive") {
      const model: ImageModelPreference = "openai/gpt-image-2";
      return {
        feature: "image_generation",
        provider: "pollinations",
        model,
        adapterModelOverride: model,
        safeModelLabel: "Precision Image",
        route: "image",
      };
    }
    const model: ImageModelPreference = "@cf/black-forest-labs/flux-2-klein-9b";
    return {
      feature: "image_generation",
      provider: "cloudflare",
      model,
      adapterModelOverride: model,
      safeModelLabel: "Precision Image",
      route: "image",
    };
  }

  return getImageModelForPlan(plan, args.requiresTextRendering ?? false);
}

export function getDeepResearchRoute(): ModelRoute {
  return {
    feature: "deep_research",
    provider: "tavily",
    model: "pro",
    adapterModelOverride: "pro",
    safeModelLabel: "Deep Research",
    route: "deep_research",
  };
}
