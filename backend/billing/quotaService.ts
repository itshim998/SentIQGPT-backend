import { BillingRepository } from "./billingRepository";
import type { BillingIdentity, BillingPlanCode, BillableFeature, UsageReservation } from "./entitlementTypes";
import {
  getAdvancedReasoningRoute,
  getGeminiAdvancedReasoningCapabilityRoute,
  getGeminiLiteCapabilityRoute,
  getGeminiStandardCapabilityRoute,
  getLiteTextRoute,
  getPremiumTextRoute,
  type ModelRoute,
} from "./modelEntitlementRouter";
import {
  routeCanServeRequiredCapabilities,
  type RequiredModelCapability,
} from "../ai/modelToolCapability";

export class ModelCapabilityUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "model_capability_unavailable";
  readonly requiredCapabilities: readonly RequiredModelCapability[];

  constructor(requiredCapabilities: readonly RequiredModelCapability[]) {
    super("A compatible model is temporarily unavailable for this request. Please try again later.");
    this.name = "ModelCapabilityUnavailableError";
    this.requiredCapabilities = [...requiredCapabilities];
  }
}

export class BillingQuotaError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly feature: BillableFeature;
  readonly planCode?: BillingPlanCode;
  readonly resetAt?: string | null;
  readonly limit?: number;
  readonly remaining?: number;
  readonly upgradeCta?: string;

  constructor(message: string, options: {
    readonly statusCode?: number;
    readonly code: string;
    readonly feature: BillableFeature;
    readonly planCode?: BillingPlanCode;
    readonly resetAt?: string | null;
    readonly limit?: number;
    readonly remaining?: number;
    readonly upgradeCta?: string;
  }) {
    super(message);
    this.name = "BillingQuotaError";
    this.statusCode = options.statusCode ?? 429;
    this.code = options.code;
    this.feature = options.feature;
    this.planCode = options.planCode;
    this.resetAt = options.resetAt;
    this.limit = options.limit;
    this.remaining = options.remaining;
    this.upgradeCta = options.upgradeCta;
  }
}

export function normalizePlanCode(value: unknown): BillingPlanCode {
  const code = typeof value === "string" ? value : "free";
  if (code === "student_core" || code === "premium" || code === "pro") return code;
  return "free";
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function normalizeNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildQuotaErrorPayload(error: BillingQuotaError) {
  return {
    error: error.message,
    code: error.code,
    type: "quota_exceeded",
    feature: error.feature,
    plan_code: error.planCode,
    reset_at: error.resetAt,
    limit: error.limit,
    remaining: error.remaining,
    upgrade_cta: error.upgradeCta,
  };
}

export class BillingQuotaService {
  constructor(private readonly repository = new BillingRepository()) {}

  async getUsageSummary(identity: BillingIdentity): Promise<any> {
    return this.repository.getUsageSummary(identity);
  }

  async resolvePlanCode(identity: BillingIdentity): Promise<BillingPlanCode> {
    if (identity.isGuest || !identity.userId) return "free";
    try {
      const summary = await this.getUsageSummary(identity);
      return normalizePlanCode(summary?.plan_code);
    } catch (error) {
      console.warn(JSON.stringify({
        scope: "context_budget",
        event: "plan_resolution_failed",
        fallback_plan: "free",
        error_type: error instanceof Error ? error.name : "unknown",
      }));
      return "free";
    }
  }

  async reserveFeature(args: {
    readonly identity: BillingIdentity;
    readonly feature: BillableFeature;
    readonly requestId: string;
    readonly route: ModelRoute;
    readonly units?: number;
    readonly conversationId?: string | null;
    readonly clientRequestId?: string | null;
    readonly metadata?: Record<string, unknown>;
  }): Promise<UsageReservation> {
    const result = await this.repository.reserveUsage({
      identity: args.identity,
      feature: args.feature,
      units: args.units ?? 1,
      requestId: args.requestId,
      metadata: {
        ...(args.metadata ?? {}),
        safe_model_label: args.route.safeModelLabel,
        conversation_id: args.conversationId ?? null,
        client_request_id: args.clientRequestId ?? args.requestId,
      },
    });

    if (!normalizeBoolean(result?.reserved)) {
      const planCode = normalizePlanCode(result?.plan_code);
      const limit = normalizeNumber(result?.limit);
      const remaining = normalizeNumber(result?.remaining);
      const resetAt = typeof result?.reset_at === "string" ? result.reset_at : null;
      throw new BillingQuotaError(
        args.feature === "lite_text"
          ? "You've used today's free AI messages. Upgrade to Essential for INR 99/month or come back after the reset."
          : `${args.route.safeModelLabel} limit reached.`,
        {
          code: "quota_exceeded",
          feature: args.feature,
          planCode,
          resetAt,
          limit,
          remaining,
          upgradeCta: planCode === "free" ? "Upgrade to Essential" : "Upgrade plan",
        },
      );
    }

    return {
      requestId: args.requestId,
      feature: args.feature,
      planCode: normalizePlanCode(result?.plan_code),
      safeModelLabel: args.route.safeModelLabel,
      provider: args.route.provider,
      model: args.route.model,
      adapterModelOverride: args.route.adapterModelOverride,
      route: args.route.route,
      remaining: normalizeNumber(result?.remaining),
      limit: normalizeNumber(result?.limit),
      resetAt: typeof result?.reset_at === "string" ? result.reset_at : null,
    };
  }

  async reserveTextRoute(args: {
    readonly identity: BillingIdentity;
    readonly requestId: string;
    readonly conversationId?: string | null;
    readonly clientRequestId?: string | null;
    readonly metadata?: Record<string, unknown>;
    readonly requiredCapabilities?: readonly RequiredModelCapability[];
  }): Promise<UsageReservation> {
    const requiredCapabilities = args.requiredCapabilities ?? [];
    const configuredStandard = getPremiumTextRoute();
    const standard = routeCanServeRequiredCapabilities(configuredStandard, requiredCapabilities)
      ? configuredStandard
      : getGeminiStandardCapabilityRoute();
    if (!routeCanServeRequiredCapabilities(standard, requiredCapabilities)) {
      throw new ModelCapabilityUnavailableError(requiredCapabilities);
    }
    try {
      return await this.reserveFeature({
        ...args,
        feature: "premium_text",
        route: standard,
      });
    } catch (error) {
      if (!(error instanceof BillingQuotaError) || error.code !== "quota_exceeded") {
        throw error;
      }
      const configuredLite = getLiteTextRoute();
      const lite = routeCanServeRequiredCapabilities(configuredLite, requiredCapabilities)
        ? configuredLite
        : getGeminiLiteCapabilityRoute();
      if (!routeCanServeRequiredCapabilities(lite, requiredCapabilities)) {
        throw new ModelCapabilityUnavailableError(requiredCapabilities);
      }
      return this.reserveFeature({
        ...args,
        requestId: `${args.requestId}:lite`,
        feature: "lite_text",
        route: lite,
        metadata: {
          ...(args.metadata ?? {}),
          downgraded_from: "premium_text",
          standard_reset_at: error.resetAt ?? null,
        },
      });
    }
  }

  async reserveAdvancedReasoning(args: {
    readonly identity: BillingIdentity;
    readonly requestId: string;
    readonly conversationId?: string | null;
    readonly clientRequestId?: string | null;
    readonly metadata?: Record<string, unknown>;
    readonly requiredCapabilities?: readonly RequiredModelCapability[];
  }): Promise<UsageReservation> {
    const requiredCapabilities = args.requiredCapabilities ?? [];
    const configuredRoute = getAdvancedReasoningRoute();
    const route = routeCanServeRequiredCapabilities(configuredRoute, requiredCapabilities)
      ? configuredRoute
      : getGeminiAdvancedReasoningCapabilityRoute();
    if (!routeCanServeRequiredCapabilities(route, requiredCapabilities)) {
      throw new ModelCapabilityUnavailableError(requiredCapabilities);
    }
    return this.reserveFeature({
      ...args,
      feature: "advanced_reasoning",
      route,
    });
  }

  async commit(reservation: UsageReservation, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.repository.commitReservation({
      requestId: reservation.requestId,
      provider: reservation.provider,
      model: reservation.model,
      route: reservation.route,
      metadata: {
        safe_model_label: reservation.safeModelLabel,
        ...metadata,
      },
    });
  }

  async release(reservation: UsageReservation | null | undefined): Promise<void> {
    if (!reservation) return;
    await this.repository.releaseReservation(reservation.requestId);
  }
}
