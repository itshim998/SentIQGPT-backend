import type { BillingPlanCode, BillableFeature } from "./entitlementTypes";

export interface ModelRoute {
  readonly feature: BillableFeature;
  readonly provider: string;
  readonly model: string;
  readonly adapterModelOverride: string;
  readonly safeModelLabel: string;
  readonly route: "standard" | "lite" | "advanced_reasoning" | "image" | "deep_research";
}

const TEXT_RENDERING_PATTERNS: readonly RegExp[] = [
  /\b(?:logo|poster|banner|title|text|typography|label|sign|quote|words|heading|ui\s*mockup|chart\s*label)\b/i,
  /["'“”‘’][^"'“”‘’]{2,}["'“”‘’]/,
];

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

export function imagePromptNeedsTextRendering(prompt: string): boolean {
  return TEXT_RENDERING_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function getImageModelForPlan(planCode: BillingPlanCode, prompt: string): ModelRoute {
  const needsText = imagePromptNeedsTextRendering(prompt);
  if (!needsText) {
    const model = readModel("SENTIQ_IMAGE_MODEL_NORMAL", "pollinations:zimage");
    return {
      feature: "image_generation",
      provider: model.provider || "pollinations",
      model: model.model,
      adapterModelOverride: model.adapterModelOverride,
      safeModelLabel: "Image",
      route: "image",
    };
  }

  const premium = planCode === "premium" || planCode === "pro";
  const model = readModel(
    premium ? "SENTIQ_IMAGE_MODEL_TEXT_PREMIUM" : "SENTIQ_IMAGE_MODEL_TEXT_CORE",
    premium ? "pollinations:gptimage-large" : "pollinations:gptimage",
  );
  return {
    feature: "image_generation",
    provider: model.provider || "pollinations",
    model: model.model,
    adapterModelOverride: model.adapterModelOverride,
    safeModelLabel: "Precision Image",
    route: "image",
  };
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
