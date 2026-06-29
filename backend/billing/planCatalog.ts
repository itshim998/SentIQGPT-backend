import type { BillingMode, BillingPlan, BillingPlanCode, BillableFeature, FeatureQuota } from "./entitlementTypes";
import { PRODUCT_NAME } from "../branding";

const INR = "INR";

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
      description: "Starter access with transparent rolling limits.",
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
          premiumText: quota(10, 8 * 60 * 60, "Standard messages"),
          liteText: quota(40, 24 * 60 * 60, "Lite messages"),
          imageGeneration: quota(2, 24 * 60 * 60, "Images"),
          advancedReasoning: quota(readQuotaLimit("SENTIQ_ADVANCED_REASONING_FREE_DAILY", 0), 24 * 60 * 60, "Advanced reasoning"),
          deepResearch: quota(7, 2592000, "Deep Researches"),
        }),
      },
    },
    {
      code: "student_core",
      name: "Student Core",
      description: "Affordable Standard access for students.",
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
          premiumText: quota(50, 8 * 60 * 60, "Standard messages"),
          liteText: quota(160, 24 * 60 * 60, "Lite messages"),
          imageGeneration: quota(4, 12 * 60 * 60, "Images"),
          advancedReasoning: quota(readQuotaLimit("SENTIQ_ADVANCED_REASONING_STUDENT_CORE_DAILY", 3), 24 * 60 * 60, "Advanced reasoning"),
          deepResearch: quota(15, 2592000, "Deep Researches"),
        }),
      },
    },
    {
      code: "premium",
      name: "Premium",
      description: "Best value for heavier student workflows.",
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
          premiumText: quota(75, 8 * 60 * 60, "Standard messages"),
          liteText: quota(260, 24 * 60 * 60, "Lite messages"),
          imageGeneration: quota(8, 12 * 60 * 60, "Images"),
          advancedReasoning: quota(readQuotaLimit("SENTIQ_ADVANCED_REASONING_PREMIUM_DAILY", 8), 24 * 60 * 60, "Advanced reasoning"),
          deepResearch: quota(30, 2592000, "Deep Researches"),
        }),
      },
    },
    {
      code: "pro",
      name: "Pro",
      description: `Highest ${PRODUCT_NAME} limits for regular power use.`,
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
          premiumText: quota(100, 6 * 60 * 60, "Standard messages"),
          liteText: quota(400, 24 * 60 * 60, "Lite messages"),
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
            },
          ]),
      ),
      safe_labels: plan.entitlements.safeLabels,
    },
  };
}
