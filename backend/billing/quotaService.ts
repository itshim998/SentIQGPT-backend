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
import {
  attachTokenAllowanceAccounting,
  closeTokenAllowanceAccounting,
  getTokenAllowanceAccounting,
} from "../context/requestBudgetContext";
import { TEXT_TOKEN_POLICY_VERSION } from "./planCatalog";
import { HttpError } from "../httpErrors";

const STANDARD_TOKEN_RESERVATION = 16_000;
const LITE_TOKEN_RESERVATION = 12_000;
const MINIMUM_MEANINGFUL_TOKEN_RESERVATION = 256;

function isTextTokenFeature(feature: BillableFeature): feature is "premium_text" | "lite_text" {
  return feature === "premium_text" || feature === "lite_text";
}

function logQuotaLifecycle(event: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ scope: "token_quota", event, ...fields }));
}

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
      units: args.units ?? (args.feature === "premium_text"
        ? STANDARD_TOKEN_RESERVATION
        : args.feature === "lite_text"
          ? LITE_TOKEN_RESERVATION
          : 1),
      requestId: args.requestId,
      metadata: {
        ...(args.metadata ?? {}),
        safe_model_label: args.route.safeModelLabel,
        conversation_id: args.conversationId ?? null,
        client_request_id: args.clientRequestId ?? args.requestId,
        ...(isTextTokenFeature(args.feature) ? {
          quota_policy_version: TEXT_TOKEN_POLICY_VERSION,
          minimum_tokens: MINIMUM_MEANINGFUL_TOKEN_RESERVATION,
        } : {}),
      },
    });

    if (!normalizeBoolean(result?.reserved)) {
      const planCode = normalizePlanCode(result?.plan_code);
      const limit = normalizeNumber(result?.limit);
      const remaining = normalizeNumber(result?.remaining);
      const resetAt = typeof result?.reset_at === "string" ? result.reset_at : null;
      throw new BillingQuotaError(
        isTextTokenFeature(args.feature)
          ? `You do not have enough ${args.feature === "lite_text" ? "Lite" : "Standard"} tokens remaining for this request. Your allowance will refresh automatically.`
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

    if (isTextTokenFeature(args.feature) && !Number.isFinite(Number(result?.reservation_units))) {
      await this.repository.releaseReservation(args.requestId).catch(() => undefined);
      throw new HttpError(503, "Token allowances are temporarily unavailable. Please try again shortly.", {
        code: "token_policy_migration_required",
        expose: true,
      });
    }

    const reservation = {
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
      reservedUnits: normalizeNumber(result?.reservation_units, args.units ?? 1),
      resetAt: typeof result?.reset_at === "string" ? result.reset_at : null,
    };
    if (isTextTokenFeature(args.feature)) {
      attachTokenAllowanceAccounting({
        feature: args.feature,
        requestId: args.requestId,
        planCode: reservation.planCode,
        windowIdentity: typeof result?.window_identity === "string" ? result.window_identity : null,
        reservedTokens: reservation.reservedUnits,
      });
      logQuotaLifecycle("reserved", {
        allowance_class: args.feature === "lite_text" ? "lite" : "standard",
        plan_policy: TEXT_TOKEN_POLICY_VERSION,
        window_identity: typeof result?.window_identity === "string" ? result.window_identity : null,
        reserved_tokens: reservation.reservedUnits,
        idempotent: normalizeBoolean(result?.idempotent),
      });
    }
    return reservation;
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
    const accounting = isTextTokenFeature(reservation.feature)
      ? getTokenAllowanceAccounting(reservation.requestId)
      : null;
    if (accounting && accounting.successfulCalls === 0) {
      await this.release(reservation, "no_successful_model_call");
      return;
    }
    const actualTokens = accounting
      ? Math.max(1, accounting.inputTokens + accounting.outputTokens)
      : undefined;
    if (accounting) {
      closeTokenAllowanceAccounting({ requestId: reservation.requestId });
    }
    const result = await this.repository.commitReservation({
      requestId: reservation.requestId,
      provider: reservation.provider,
      model: reservation.model,
      route: reservation.route,
      metadata: {
        safe_model_label: reservation.safeModelLabel,
        ...(actualTokens !== undefined ? {
          actual_token_units: actualTokens,
           input_tokens: accounting?.inputTokens ?? 0,
           output_tokens: accounting?.outputTokens ?? 0,
           observed_input_tokens: accounting?.observedInputTokens ?? 0,
           observed_output_tokens: accounting?.observedOutputTokens ?? 0,
           usage_overrun_tokens: accounting?.usageOverrunTokens ?? 0,
           successful_model_calls: accounting?.successfulCalls ?? 0,
          usage_reported_calls: accounting?.reportedCalls ?? 0,
          usage_estimated_calls: accounting?.estimatedCalls ?? 0,
          quota_policy_version: TEXT_TOKEN_POLICY_VERSION,
        } : {}),
        ...metadata,
      },
    });
    if (accounting) {
      const settledTokens = normalizeNumber(result?.settled_units, actualTokens ?? 0);
      logQuotaLifecycle("settled", {
        allowance_class: reservation.feature === "lite_text" ? "lite" : "standard",
        plan_policy: TEXT_TOKEN_POLICY_VERSION,
        window_identity: accounting.windowIdentity,
        reserved_tokens: accounting.reservedTokens,
        actual_settled_tokens: settledTokens,
        reported_calls: accounting.reportedCalls,
        estimated_calls: accounting.estimatedCalls,
        released_tokens: normalizeNumber(
          result?.released_units,
          Math.max(0, accounting.reservedTokens - settledTokens),
        ),
        idempotent: normalizeBoolean(result?.idempotent),
      });
    }
  }

  async release(reservation: UsageReservation | null | undefined, reason = "unchargeable_failure"): Promise<void> {
    if (!reservation) return;
    if (isTextTokenFeature(reservation.feature)) {
      closeTokenAllowanceAccounting({
        requestId: reservation.requestId,
        releasePending: true,
      });
    }
    const result = await this.repository.releaseReservation(reservation.requestId);
    if (isTextTokenFeature(reservation.feature)) {
      const accounting = getTokenAllowanceAccounting(reservation.requestId);
      logQuotaLifecycle("released", {
        allowance_class: reservation.feature === "lite_text" ? "lite" : "standard",
        plan_policy: TEXT_TOKEN_POLICY_VERSION,
        window_identity: accounting?.windowIdentity ?? null,
        reserved_tokens: accounting?.reservedTokens ?? reservation.reservedUnits,
        actual_settled_tokens: 0,
        released_tokens: accounting?.reservedTokens ?? reservation.reservedUnits,
        failure_release_reason: reason,
        idempotent: normalizeBoolean(result?.idempotent),
      });
    }
  }
}
