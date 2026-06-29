export type BillingPlanCode = "free" | "student_core" | "premium" | "pro";

export type BillingMode = "disabled" | "manual" | "razorpay_test" | "razorpay_live";

export type BillableFeature =
  | "premium_text"
  | "lite_text"
  | "image_generation"
  | "advanced_reasoning"
  | "file_analysis"
  | "web_search"
  | "generated_file"
  | "deep_research";

export interface FeatureQuota {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly label: string;
}

export interface PlanEntitlements {
  readonly quotas: Record<BillableFeature, FeatureQuota>;
  readonly safeLabels: {
    readonly premiumText: string;
    readonly liteText: string;
    readonly image: string;
    readonly precisionImage: string;
  };
}

export interface BillingPlan {
  readonly code: BillingPlanCode;
  readonly name: string;
  readonly description: string;
  readonly currency: string;
  readonly pricePaise: number;
  readonly interval: "month";
  readonly sortOrder: number;
  readonly isPublic: boolean;
  readonly isActive: boolean;
  readonly providerPlanIds: Record<string, string>;
  readonly entitlements: PlanEntitlements;
}

export interface UsageQuotaSummary {
  readonly label: string;
  readonly used: number;
  readonly reserved: number;
  readonly limit: number;
  readonly remaining: number;
  readonly windowSeconds: number;
  readonly resetAt: string | null;
}

export interface BillingIdentity {
  readonly userId: string | null;
  readonly anonymousKeyHash: string | null;
  readonly isGuest: boolean;
}

export interface UsageReservation {
  readonly requestId: string;
  readonly feature: BillableFeature;
  readonly planCode: BillingPlanCode;
  readonly safeModelLabel: string;
  readonly provider: string;
  readonly model: string;
  readonly adapterModelOverride: string;
  readonly route: "standard" | "lite" | "advanced_reasoning" | "image" | "deep_research";
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: string | null;
}
