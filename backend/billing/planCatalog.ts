import type { BillingMode, BillingPlan, BillingPlanCode, BillableFeature, FeatureQuota } from "./entitlementTypes";

const INR = "INR";

export const TEXT_TOKEN_POLICY_VERSION = "standard-lite-tokens-v1";
export const UNIFIED_TEXT_POLICY_VERSION = "unified-text-tokens-v2";

export const FREE_UNIFIED_TEXT_LIMIT_TOKENS = 50_000;
export const FREE_UNIFIED_TEXT_WINDOW_SECONDS = 18_000;
export const FREE_UNIFIED_TEXT_FAST_RESERVE_TOKENS = 10_000;

export const FREE_UNIFIED_TEXT_POLICY = Object.freeze({
  policyVersion: UNIFIED_TEXT_POLICY_VERSION,
  limitTokens: FREE_UNIFIED_TEXT_LIMIT_TOKENS,
  windowSeconds: FREE_UNIFIED_TEXT_WINDOW_SECONDS,
  fastReserveTokens: FREE_UNIFIED_TEXT_FAST_RESERVE_TOKENS,
  fastDesiredReservationTokens: 12_000,
  intuitiveDesiredReservationTokens: 16_000,
  fastMinimumReservationTokens: 256,
  intuitiveOrdinaryMinimumReservationTokens: 1_500,
  intuitiveComplexMinimumReservationTokens: 2_000,
} as const);

export const TEXT_TOKEN_PLAN_POLICY: Readonly<Record<BillingPlanCode, {
  readonly standardTokens: number;
  readonly liteTokens: number;
}>> = Object.freeze({
  free: Object.freeze({ standardTokens: 25_000, liteTokens: 50_000 }),
  student_core: Object.freeze({ standardTokens: 100_000, liteTokens: 175_000 }),
  premium: Object.freeze({ standardTokens: 180_000, liteTokens: 325_000 }),
  pro: Object.freeze({ standardTokens: 300_000, liteTokens: 550_000 }),
});

function readBillingMode(): BillingMode {
  const raw = (process.env.SENTIQ_BILLING_MODE || "disabled").trim();
  if (raw === "manual" || raw === "razorpay_test" || raw === "razorpay_live") return raw;
  return "disabled";
}

export function getBillingMode(): BillingMode {
  return readBillingMode();
}

function readPricePaise(envName: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[envName] || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readQuotaLimit(envName: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[envName] || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function quota(limit: number, windowSeconds: number, label: string): FeatureQuota {
  return { limit, windowSeconds, label };
}

const baseFeatureKeys: readonly BillableFeature[] = [
  "premium_text",
  "lite_text",
  "image_generation",
  "advanced_reasoning",
  "file_analysis",
  "web_search",
  "generated_file",
  "deep_research",
];

function buildQuotas(values: {
  readonly premiumText: FeatureQuota;
  readonly liteText: FeatureQuota;
  readonly imageGeneration: FeatureQuota;
  readonly advancedReasoning: FeatureQuota;
  readonly deepResearch: FeatureQuota;
}): Record<BillableFeature, FeatureQuota> {
  return {
    premium_text: values.premiumText,
    lite_text: values.liteText,
    image_generation: values.imageGeneration,
    advanced_reasoning: values.advancedReasoning,
    deep_research: values.deepResearch,
    file_analysis: quota(Number.MAX_SAFE_INTEGER, 86_400, "File analysis"),
    web_search: quota(Number.MAX_SAFE_INTEGER, 86_400, "Web search"),
    generated_file: quota(Number.MAX_SAFE_INTEGER, 86_400, "Generated files"),
  };
}

export function getPlanCatalog(): readonly BillingPlan[] {
  const currency = process.env.SENTIQ_BILLING_CURRENCY?.trim() || INR;
  const safeLabels = {
    premiumText: "Standard",
    liteText: "Lite",
    image: "Image",
    precisionImage: "Precision Image",
  };

  return [
    {
      code: "free",
      name: "Free",
      description: "A straightforward way to get started, with clear rolling limits.",
      currency,
      pricePaise: readPricePaise("SENTIQ_PLAN_FREE_PRICE_PAISE", 0),
      interval: "month",
      sortOrder: 10,
      isPublic: true,
      isActive: true,
      providerPlanIds: {},
      entitlements: {
        safeLabels,
        quotas: buildQuotas({
          premiumText: quota(TEXT_TOKEN_PLAN_POLICY.free.standardTokens, 8 * 60 * 60, "Standard tokens"),
          liteText: quota(TEXT_TOKEN_PLAN_POLICY.free.liteTokens, 24 * 60 * 60, "Lite tokens"),
          imageGeneration: quota(2, 24 * 60 * 60, "Images"),
          advancedReasoning: quota(readQuotaLimit("SENTIQ_ADVANCED_REASONING_FREE_DAILY", 0), 24 * 60 * 60, "Advanced reasoning"),
          deepResearch: quota(7, 2592000, "Deep Researches"),
        }),
      },
    },
    {
      code: "student_core",
      name: "Essential",
      description: "Balanced access for regular, everyday use.",
      currency,
      pricePaise: readPricePaise("SENTIQ_PLAN_STUDENT_CORE_PRICE_PAISE", 9_900),
      interval: "month",
      sortOrder: 20,
      isPublic: true,
      isActive: true,
      providerPlanIds: { razorpay: process.env.RAZORPAY_PLAN_STUDENT_CORE?.trim() || "" },
      entitlements: {
        safeLabels,
        quotas: buildQuotas({
          premiumText: quota(TEXT_TOKEN_PLAN_POLICY.student_core.standardTokens, 8 * 60 * 60, "Standard tokens"),
          liteText: quota(TEXT_TOKEN_PLAN_POLICY.student_core.liteTokens, 24 * 60 * 60, "Lite tokens"),
          imageGeneration: quota(4, 12 * 60 * 60, "Images"),
          advancedReasoning: quota(readQuotaLimit("SENTIQ_ADVANCED_REASONING_STUDENT_CORE_DAILY", 3), 24 * 60 * 60, "Advanced reasoning"),
          deepResearch: quota(15, 2592000, "Deep Researches"),
        }),
      },
    },
    {
      code: "premium",
      name: "Plus",
      description: "Expanded limits for frequent and more involved workflows.",
      currency,
      pricePaise: readPricePaise("SENTIQ_PLAN_PREMIUM_PRICE_PAISE", 24_900),
      interval: "month",
      sortOrder: 30,
      isPublic: true,
      isActive: true,
      providerPlanIds: { razorpay: process.env.RAZORPAY_PLAN_PREMIUM?.trim() || "" },
      entitlements: {
        safeLabels,
        quotas: buildQuotas({
          premiumText: quota(TEXT_TOKEN_PLAN_POLICY.premium.standardTokens, 8 * 60 * 60, "Standard tokens"),
          liteText: quota(TEXT_TOKEN_PLAN_POLICY.premium.liteTokens, 24 * 60 * 60, "Lite tokens"),
          imageGeneration: quota(8, 12 * 60 * 60, "Images"),
          advancedReasoning: quota(readQuotaLimit("SENTIQ_ADVANCED_REASONING_PREMIUM_DAILY", 8), 24 * 60 * 60, "Advanced reasoning"),
          deepResearch: quota(30, 2592000, "Deep Researches"),
        }),
      },
    },
    {
      code: "pro",
      name: "Pro",
      description: "Our highest limits for sustained, demanding use.",
      currency,
      pricePaise: readPricePaise("SENTIQ_PLAN_PRO_PRICE_PAISE", 54_900),
      interval: "month",
      sortOrder: 40,
      isPublic: true,
      isActive: true,
      providerPlanIds: { razorpay: process.env.RAZORPAY_PLAN_PRO?.trim() || "" },
      entitlements: {
        safeLabels,
        quotas: buildQuotas({
          premiumText: quota(TEXT_TOKEN_PLAN_POLICY.pro.standardTokens, 6 * 60 * 60, "Standard tokens"),
          liteText: quota(TEXT_TOKEN_PLAN_POLICY.pro.liteTokens, 24 * 60 * 60, "Lite tokens"),
          imageGeneration: quota(12, 12 * 60 * 60, "Images"),
          advancedReasoning: quota(readQuotaLimit("SENTIQ_ADVANCED_REASONING_PRO_DAILY", 20), 24 * 60 * 60, "Advanced reasoning"),
          deepResearch: quota(50, 2592000, "Deep Researches"),
        }),
      },
    },
  ];
}

export function getPlanByCode(code: string | null | undefined): BillingPlan {
  const plans = getPlanCatalog();
  return plans.find((plan) => plan.code === code) ?? plans[0];
}

export function isBillingPlanCode(value: string): value is BillingPlanCode {
  return getPlanCatalog().some((plan) => plan.code === value);
}

export function featureKeys(): readonly BillableFeature[] {
  return baseFeatureKeys;
}

export function toPublicPlan(plan: BillingPlan) {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    price_paise: plan.pricePaise,
    interval: plan.interval,
    sort_order: plan.sortOrder,
    entitlements: {
      quotas: Object.fromEntries(
        Object.entries(plan.entitlements.quotas)
          .filter(([, quotaValue]) => Number.isFinite(quotaValue.limit) && quotaValue.limit < Number.MAX_SAFE_INTEGER)
          .map(([feature, quotaValue]) => [
            feature,
            {
              label: quotaValue.label,
              limit: quotaValue.limit,
              window_seconds: quotaValue.windowSeconds,
              ...(feature === "premium_text" || feature === "lite_text"
                ? { policy_version: TEXT_TOKEN_POLICY_VERSION, unit: "tokens" }
                : { unit: "count" }),
            },
          ]),
      ),
      safe_labels: plan.entitlements.safeLabels,
    },
  };
}
