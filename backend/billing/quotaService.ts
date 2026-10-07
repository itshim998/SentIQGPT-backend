import { BillingRepository, BillingRepositoryError } from "./billingRepository";
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
  getRequestBudgetContext,
  getTokenAllowanceAccounting,
} from "../context/requestBudgetContext";
import {
  FREE_UNIFIED_TEXT_POLICY,
  TEXT_TOKEN_POLICY_VERSION,
  UNIFIED_TEXT_POLICY_VERSION,
} from "./planCatalog";
import { HttpError } from "../httpErrors";
import { getNemotronRolloutSnapshot } from "../nemotronRolloutFlags";
import { normalizeExecutionMode, type ExecutionMode } from "../orchestrator/executionProfile";
import type { RequestComplexity } from "../orchestrator/contextBudgetManager";

const STANDARD_TOKEN_RESERVATION = 16_000;
const LITE_TOKEN_RESERVATION = 12_000;
const MINIMUM_MEANINGFUL_TOKEN_RESERVATION = 256;

function isTextTokenFeature(feature: BillableFeature | "unified_text"): feature is "premium_text" | "lite_text" {
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
  readonly type: string;
  readonly feature?: BillableFeature;
  readonly planCode?: BillingPlanCode;
  readonly resetAt?: string | null;
  readonly limit?: number;
  readonly remaining?: number;
  readonly upgradeCta?: string;
  readonly policyVersion?: string;
  readonly requiredMode?: ExecutionMode | null;
  readonly limitTokens?: number;
  readonly usedTokens?: number;
  readonly reservedTokens?: number;
  readonly remainingTokens?: number;
  readonly fastReserveTokens?: number;
  readonly fastAvailableTokens?: number;
  readonly intuitiveAvailableTokens?: number;
  readonly nextRecoveryAt?: string | null;

  constructor(message: string, options: {
    readonly statusCode?: number;
    readonly code: string;
    readonly type?: string;
    readonly feature?: BillableFeature;
    readonly planCode?: BillingPlanCode;
    readonly resetAt?: string | null;
    readonly limit?: number;
    readonly remaining?: number;
    readonly upgradeCta?: string;
    readonly policyVersion?: string;
    readonly requiredMode?: ExecutionMode | null;
    readonly limitTokens?: number;
    readonly usedTokens?: number;
    readonly reservedTokens?: number;
    readonly remainingTokens?: number;
    readonly fastReserveTokens?: number;
    readonly fastAvailableTokens?: number;
    readonly intuitiveAvailableTokens?: number;
    readonly nextRecoveryAt?: string | null;
  }) {
    super(message);
    this.name = "BillingQuotaError";
    this.statusCode = options.statusCode ?? 429;
    this.code = options.code;
    this.type = options.type ?? "quota_exceeded";
    this.feature = options.feature;
    this.planCode = options.planCode;
    this.resetAt = options.resetAt;
    this.limit = options.limit;
    this.remaining = options.remaining;
    this.upgradeCta = options.upgradeCta;
    this.policyVersion = options.policyVersion;
    this.requiredMode = options.requiredMode;
    this.limitTokens = options.limitTokens;
    this.usedTokens = options.usedTokens;
    this.reservedTokens = options.reservedTokens;
    this.remainingTokens = options.remainingTokens;
    this.fastReserveTokens = options.fastReserveTokens;
    this.fastAvailableTokens = options.fastAvailableTokens;
    this.intuitiveAvailableTokens = options.intuitiveAvailableTokens;
    this.nextRecoveryAt = options.nextRecoveryAt;
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
    type: error.type,
    feature: error.feature,
    plan_code: error.planCode,
    policy_version: error.policyVersion,
    required_mode: error.requiredMode,
    limit_tokens: error.limitTokens,
    used_tokens: error.usedTokens,
    reserved_tokens: error.reservedTokens,
    remaining_tokens: error.remainingTokens,
    fast_reserve_tokens: error.fastReserveTokens,
    fast_available_tokens: error.fastAvailableTokens,
    intuitive_available_tokens: error.intuitiveAvailableTokens,
    next_recovery_at: error.nextRecoveryAt,
    reset_at: error.resetAt,
    limit: error.limit,
    remaining: error.remaining,
    upgrade_cta: error.upgradeCta,
  };
}

function isUnifiedTextV2EnabledForPlan(planCode: BillingPlanCode): boolean {
  return planCode === "free" && getNemotronRolloutSnapshot().unifiedTextTokensV2;
}

function readTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function hideRollbackShadowFromQuota(quota: any, shadowTokens: number): any {
  if (shadowTokens <= 0 || !quota) return quota;
  const used = Math.max(0, normalizeNumber(quota.used) - shadowTokens);
  const reserved = Math.max(0, normalizeNumber(quota.reserved));
  const limit = Math.max(0, normalizeNumber(quota.limit));
  const remaining = Math.max(0, limit - used - reserved);
  return {
    ...quota,
    used,
    remaining,
    tokens_consumed: used,
    tokens_remaining: remaining,
  };
}

function hideRollbackShadowsFromV1Summary(
  summary: any,
  shadows: { readonly standardTokens: number; readonly liteTokens: number },
): any {
  if (!summary?.quotas) return summary;
  const premiumText = hideRollbackShadowFromQuota(summary.quotas.premium_text, shadows.standardTokens);
  const liteText = hideRollbackShadowFromQuota(summary.quotas.lite_text, shadows.liteTokens);
  if (premiumText === summary.quotas.premium_text && liteText === summary.quotas.lite_text) return summary;
  return {
    ...summary,
    quotas: {
      ...summary.quotas,
      premium_text: premiumText,
      lite_text: liteText,
    },
  };
}

function buildUnifiedTextError(result: any): BillingQuotaError {
  const reason = typeof result?.reason === "string"
    ? result.reason
    : "unified_text_quota_unavailable";
  const planCode = normalizePlanCode(result?.plan_code);
  const nextRecoveryAt = readTimestamp(result?.next_recovery_at);
  const common = {
    planCode,
    policyVersion: UNIFIED_TEXT_POLICY_VERSION,
    requiredMode: (result?.required_mode === "fast" ? "fast" : null) as ExecutionMode | null,
    limitTokens: normalizeNumber(result?.limit_tokens, FREE_UNIFIED_TEXT_POLICY.limitTokens),
    usedTokens: normalizeNumber(result?.used_tokens),
    reservedTokens: normalizeNumber(result?.active_reserved_tokens),
    remainingTokens: normalizeNumber(result?.remaining_tokens),
    fastReserveTokens: normalizeNumber(
      result?.fast_reserve_tokens,
      FREE_UNIFIED_TEXT_POLICY.fastReserveTokens,
    ),
    fastAvailableTokens: normalizeNumber(result?.fast_available_tokens),
    intuitiveAvailableTokens: normalizeNumber(result?.intuitive_available_tokens),
    nextRecoveryAt,
    resetAt: nextRecoveryAt,
  };
  if (reason === "intuitive_fast_required") {
    return new BillingQuotaError(
      "Intuitive is unavailable while your remaining allowance is reserved for Fast. Continue with Fast or wait for tokens to refresh.",
      {
        ...common,
        code: reason,
        type: "mode_switch_required",
        requiredMode: "fast",
      },
    );
  }
  if (reason === "unified_text_quota_exhausted") {
    return new BillingQuotaError(
      "Your Free text-token allowance is currently exhausted. Tokens return progressively as recent usage leaves the rolling window.",
      {
        ...common,
        code: reason,
        type: "quota_exceeded",
        requiredMode: null,
      },
    );
  }
  if (reason === "unified_text_insufficient_for_request") {
    return new BillingQuotaError(
      "Your remaining text-token allowance cannot support this request yet. Try a smaller request or wait for tokens to refresh.",
      {
        ...common,
        code: reason,
        type: "insufficient_allowance",
        requiredMode: null,
      },
    );
  }
  return buildUnifiedTextUnavailableError();
}

function buildUnifiedTextUnavailableError(): BillingQuotaError {
  return new BillingQuotaError(
    "Text-token allowances are temporarily unavailable. Please try again shortly.",
    {
      statusCode: 503,
      code: "unified_text_quota_unavailable",
      type: "service_unavailable",
      planCode: "free",
      policyVersion: UNIFIED_TEXT_POLICY_VERSION,
      requiredMode: null,
    },
  );
}

class UnifiedTextPlanNotEligibleError extends Error {
  constructor() {
    super("Resolved plan is not eligible for unified text-token V2.");
    this.name = "UnifiedTextPlanNotEligibleError";
  }
}

export class BillingQuotaService {
  constructor(private readonly repository = new BillingRepository()) {}

  async getUsageSummary(identity: BillingIdentity): Promise<any> {
    const summary = await this.repository.getUsageSummary(identity);
    const planCode = normalizePlanCode(summary?.plan_code);
    if (!isUnifiedTextV2EnabledForPlan(planCode)) return summary;
    try {
      const textAllowance = await this.repository.getUnifiedTextUsageSummaryV2(identity);
      if (textAllowance?.eligible !== true) {
        throw buildUnifiedTextUnavailableError();
      }
      const publicTextAllowance = {
        policy_version: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        limit_tokens: normalizeNumber(textAllowance?.limit_tokens, FREE_UNIFIED_TEXT_POLICY.limitTokens),
        window_seconds: normalizeNumber(textAllowance?.window_seconds, FREE_UNIFIED_TEXT_POLICY.windowSeconds),
        used_tokens: normalizeNumber(textAllowance?.used_tokens),
        reserved_tokens: normalizeNumber(textAllowance?.active_reserved_tokens),
        remaining_tokens: normalizeNumber(textAllowance?.remaining_tokens),
        fast_reserve_tokens: normalizeNumber(
          textAllowance?.fast_reserve_tokens,
          FREE_UNIFIED_TEXT_POLICY.fastReserveTokens,
        ),
        fast_available_tokens: normalizeNumber(textAllowance?.fast_available_tokens),
        intuitive_available_tokens: normalizeNumber(textAllowance?.intuitive_available_tokens),
        intuitive_allowed: normalizeBoolean(textAllowance?.intuitive_allowed),
        required_mode: textAllowance?.required_mode === "fast" ? "fast" : null,
        exhausted: normalizeBoolean(textAllowance?.exhausted),
        next_recovery_at: readTimestamp(textAllowance?.next_recovery_at),
        full_reset_at: readTimestamp(textAllowance?.full_reset_at),
      };
      if (normalizeNumber(textAllowance?.stale_reclaimed_tokens) > 0) {
        logQuotaLifecycle("stale_reservation_reclaimed", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          reclaimed_tokens: normalizeNumber(textAllowance.stale_reclaimed_tokens),
        });
      }
      const shadowSafeSummary = hideRollbackShadowsFromV1Summary(summary, {
        standardTokens: normalizeNumber(textAllowance?.rollback_shadow_v1_standard_tokens),
        liteTokens: normalizeNumber(textAllowance?.rollback_shadow_v1_lite_tokens),
      });
      return {
        ...shadowSafeSummary,
        text_allowance: publicTextAllowance,
      };
    } catch (error) {
      logQuotaLifecycle("unified_text_v2_unavailable", {
        plan_policy: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        error_type: error instanceof Error ? error.name : "unknown",
      });
      if (error instanceof BillingQuotaError) throw error;
      throw buildUnifiedTextUnavailableError();
    }
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

  /**
   * Authoritative billing-critical plan resolution for image generation.
   * Unlike general context budgeting, this MUST fail closed:
   * A failure to resolve an authenticated user's plan must NEVER default to "free",
   * preventing undercharges when paid users consume weighted credits.
   */
  async resolvePlanCodeForImageBilling(identity: BillingIdentity): Promise<BillingPlanCode> {
    if (identity.isGuest || !identity.userId) return "free";

    let planCode: unknown;
    if (typeof (this.repository as any).getEffectivePlan === "function") {
      const effective = await (this.repository as any).getEffectivePlan(identity.userId);
      planCode = effective?.plan_code;
    } else {
      const summary = await this.getUsageSummary(identity);
      planCode = summary?.plan_code;
    }

    if (typeof planCode === "string") {
      const trimmed = planCode.trim();
      if (trimmed === "free") return "free";
      if (trimmed === "student_core") return "student_core";
      if (trimmed === "premium") return "premium";
      if (trimmed === "pro") return "pro";
    }

    throw new BillingQuotaError("Authoritative billing plan could not be determined for image billing", {
      code: "plan_resolution_failed",
      type: "plan_resolution_failed",
      feature: "image_generation",
      planCode: "free",
      policyVersion: UNIFIED_TEXT_POLICY_VERSION,
      limitTokens: 0,
      usedTokens: 0,
      reservedTokens: 0,
      remainingTokens: 0,
      fastReserveTokens: 0,
      fastAvailableTokens: 0,
      intuitiveAvailableTokens: 0,
      nextRecoveryAt: null,
      resetAt: null,
    });
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
      allowanceClass: isTextTokenFeature(args.feature)
        ? args.feature === "lite_text" ? "lite" as const : "standard" as const
        : undefined,
      policyVersion: isTextTokenFeature(args.feature) ? TEXT_TOKEN_POLICY_VERSION : undefined,
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
        allowanceClass: args.feature === "lite_text" ? "lite" : "standard",
        policyVersion: TEXT_TOKEN_POLICY_VERSION,
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

  private async reserveUnifiedTextV2(args: {
    readonly identity: BillingIdentity;
    readonly requestId: string;
    readonly executionMode: ExecutionMode;
    readonly complexity: RequestComplexity;
    readonly route: ModelRoute;
  }): Promise<UsageReservation> {
    const requestedTokens = args.executionMode === "intuitive"
      ? FREE_UNIFIED_TEXT_POLICY.intuitiveDesiredReservationTokens
      : FREE_UNIFIED_TEXT_POLICY.fastDesiredReservationTokens;
    const minimumTokens = args.executionMode === "intuitive"
      ? args.complexity === "heavy"
        ? FREE_UNIFIED_TEXT_POLICY.intuitiveComplexMinimumReservationTokens
        : FREE_UNIFIED_TEXT_POLICY.intuitiveOrdinaryMinimumReservationTokens
      : FREE_UNIFIED_TEXT_POLICY.fastMinimumReservationTokens;
    let result: any;
    try {
      result = await this.repository.reserveUnifiedTextTokensV2({
        identity: args.identity,
        requestId: args.requestId,
        executionMode: args.executionMode,
        requestedTokens,
        minimumTokens,
        metadata: {
          ttl_seconds: 600,
        },
      });
    } catch (error) {
      logQuotaLifecycle("unified_text_v2_unavailable", {
        plan_policy: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        execution_mode: args.executionMode,
        error_type: error instanceof BillingRepositoryError ? error.code : error instanceof Error ? error.name : "unknown",
      });
      throw buildUnifiedTextUnavailableError();
    }

    if (result?.reason === "plan_not_eligible") {
      throw new UnifiedTextPlanNotEligibleError();
    }
    if (!normalizeBoolean(result?.reserved)) {
      const requestReason = typeof result?.reason === "string" ? result.reason : "";
      if ([
        "request_identity_mismatch",
        "request_mode_mismatch",
        "request_policy_mismatch",
        "reservation_released",
        "reservation_expired",
      ].includes(requestReason)) {
        throw new HttpError(
          requestReason === "reservation_expired" ? 410 : 409,
          requestReason === "reservation_expired"
            ? "This request reservation expired. Start a new request."
            : "This request ID cannot be reused.",
          {
            code: "billing_request_conflict",
            expose: true,
          },
        );
      }
      const error = buildUnifiedTextError(result);
      logQuotaLifecycle("unified_text_reservation_rejected", {
        plan_policy: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        execution_mode: args.executionMode,
        reason: error.code,
        remaining_tokens: error.remainingTokens,
        intuitive_available_tokens: error.intuitiveAvailableTokens,
      });
      if (error.code === "intuitive_fast_required") {
        logQuotaLifecycle("fast_reserve_enforced", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          plan_code: "free",
          execution_mode: args.executionMode,
          remaining_tokens: error.remainingTokens,
          fast_reserve_tokens: error.fastReserveTokens,
        });
      }
      throw error;
    }

    const reservationId = typeof result?.reservation_id === "string" ? result.reservation_id : "";
    const reservationTokens = normalizeNumber(result?.reservation_tokens);
    const idempotent = normalizeBoolean(result?.idempotent);
    const status = typeof result?.status === "string" ? result.status : "reserved";
    if (idempotent) {
      throw new HttpError(
        status === "committed" ? 409 : 425,
        status === "committed"
          ? "This request has already been completed."
          : "This request is already in progress. Please wait before retrying.",
        {
          code: status === "committed" ? "billing_request_already_committed" : "billing_request_in_progress",
          expose: true,
        },
      );
    }
    if (!reservationId || reservationTokens < minimumTokens) {
      if (reservationId) {
        await this.repository.releaseUnifiedTextTokensV2({
          reservationId,
          requestId: args.requestId,
        }).catch(() => undefined);
      }
      throw buildUnifiedTextUnavailableError();
    }

    const reservation: UsageReservation = {
      reservationId,
      requestId: args.requestId,
      feature: "unified_text",
      allowanceClass: "unified_text",
      policyVersion: UNIFIED_TEXT_POLICY_VERSION,
      executionMode: args.executionMode,
      idempotent,
      status: status as UsageReservation["status"],
      planCode: "free",
      safeModelLabel: "Text",
      provider: args.route.provider,
      model: args.route.model,
      adapterModelOverride: args.route.adapterModelOverride,
      route: args.route.route,
      remaining: normalizeNumber(result?.remaining_tokens),
      limit: normalizeNumber(result?.limit_tokens, FREE_UNIFIED_TEXT_POLICY.limitTokens),
      reservedUnits: reservationTokens,
      resetAt: readTimestamp(result?.next_recovery_at),
    };
    attachTokenAllowanceAccounting({
      allowanceClass: "unified_text",
      policyVersion: UNIFIED_TEXT_POLICY_VERSION,
      requestId: args.requestId,
      planCode: "free",
      windowIdentity: reservationId,
      reservedTokens: reservationTokens,
    });
    logQuotaLifecycle("unified_text_reservation_accepted", {
      plan_policy: UNIFIED_TEXT_POLICY_VERSION,
      plan_code: "free",
      execution_mode: args.executionMode,
      reserved_tokens: reservationTokens,
      remaining_tokens: reservation.remaining,
      idempotent,
    });
    const reclaimedTokens = normalizeNumber(result?.stale_reclaimed_tokens);
    if (reclaimedTokens > 0) {
      logQuotaLifecycle("stale_reservation_reclaimed", {
        plan_policy: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        reclaimed_tokens: reclaimedTokens,
      });
    }
    const legacyUsedTokens = normalizeNumber(result?.legacy_v1_used_tokens);
    const legacyReservedTokens = normalizeNumber(result?.legacy_v1_reserved_tokens);
    if (legacyUsedTokens > 0 || legacyReservedTokens > 0) {
      logQuotaLifecycle("v1_compatibility_usage_imported", {
        plan_policy: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        legacy_used_tokens: legacyUsedTokens,
        legacy_reserved_tokens: legacyReservedTokens,
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
    readonly executionMode?: ExecutionMode;
    readonly complexity?: RequestComplexity;
  }): Promise<UsageReservation> {
    const requiredCapabilities = args.requiredCapabilities ?? [];
    const configuredStandard = getPremiumTextRoute();
    const standard = routeCanServeRequiredCapabilities(configuredStandard, requiredCapabilities)
      ? configuredStandard
      : getGeminiStandardCapabilityRoute();
    if (!routeCanServeRequiredCapabilities(standard, requiredCapabilities)) {
      throw new ModelCapabilityUnavailableError(requiredCapabilities);
    }
    const context = getRequestBudgetContext();
    const executionMode = normalizeExecutionMode(args.executionMode ?? context.executionMode);
    if (isUnifiedTextV2EnabledForPlan(normalizePlanCode(context.planCode))) {
      try {
        return await this.reserveUnifiedTextV2({
          identity: args.identity,
          requestId: args.requestId,
          executionMode,
          complexity: args.complexity ?? "normal",
          route: standard,
        });
      } catch (error) {
        if (!(error instanceof UnifiedTextPlanNotEligibleError)) throw error;
        logQuotaLifecycle("unified_text_plan_ineligible_v1_preserved", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          execution_mode: executionMode,
        });
      }
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
    const isUnifiedTextV2 = reservation.feature === "unified_text"
      && reservation.policyVersion === UNIFIED_TEXT_POLICY_VERSION;
    const accounting = isTextTokenFeature(reservation.feature) || isUnifiedTextV2
      ? getTokenAllowanceAccounting(reservation.requestId)
      : null;
    if (accounting && accounting.successfulCalls === 0) {
      await this.release(reservation, "no_successful_model_call");
      return;
    }
    if (isUnifiedTextV2) {
      if (!accounting || !reservation.reservationId) {
        throw buildUnifiedTextUnavailableError();
      }
      if (accounting.pendingCalls > 0) {
        throw new Error("Cannot settle a unified text-token reservation while model calls are pending.");
      }
      const actualTokens = Math.max(
        1,
        accounting.observedInputTokens + accounting.observedOutputTokens,
      );
      let result: any;
      try {
        result = await this.repository.commitUnifiedTextTokensV2({
          reservationId: reservation.reservationId,
          requestId: reservation.requestId,
          actualTokens,
          metadata: {
            input_tokens: accounting.inputTokens,
            output_tokens: accounting.outputTokens,
            observed_input_tokens: accounting.observedInputTokens,
            observed_output_tokens: accounting.observedOutputTokens,
            successful_model_calls: accounting.successfulCalls,
            usage_reported_calls: accounting.reportedCalls,
            usage_estimated_calls: accounting.estimatedCalls,
          },
        });
      } catch (error) {
        logQuotaLifecycle("unified_text_v2_unavailable", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          plan_code: "free",
          execution_mode: reservation.executionMode,
          request_lifecycle: "commit",
          error_type: error instanceof BillingRepositoryError ? error.code : error instanceof Error ? error.name : "unknown",
        });
        throw buildUnifiedTextUnavailableError();
      }
      if (!normalizeBoolean(result?.committed)) {
        throw buildUnifiedTextUnavailableError();
      }
      closeTokenAllowanceAccounting({ requestId: reservation.requestId });
      const overrunTokens = normalizeNumber(result?.usage_overrun_tokens);
      const reserveBreachTokens = normalizeNumber(result?.fast_reserve_breach_tokens);
      const lateSettlement = normalizeBoolean(result?.late_settlement);
      const lateCapacityOverrunTokens = normalizeNumber(result?.late_capacity_overrun_tokens);
      logQuotaLifecycle("unified_text_reservation_committed", {
        plan_policy: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        execution_mode: reservation.executionMode,
        reserved_tokens: reservation.reservedUnits,
        actual_settled_tokens: normalizeNumber(result?.actual_tokens, actualTokens),
        released_tokens: normalizeNumber(
          result?.released_tokens,
          Math.max(0, reservation.reservedUnits - actualTokens),
        ),
        usage_overrun_tokens: overrunTokens,
        fast_reserve_breach_tokens: reserveBreachTokens,
        late_settlement: lateSettlement,
        late_capacity_overrun_tokens: lateCapacityOverrunTokens,
        reported_calls: accounting.reportedCalls,
        estimated_calls: accounting.estimatedCalls,
        idempotent: normalizeBoolean(result?.idempotent),
      });
      if (lateSettlement) {
        logQuotaLifecycle("late_settlement_committed", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          plan_code: "free",
          execution_mode: reservation.executionMode,
          actual_settled_tokens: normalizeNumber(result?.actual_tokens, actualTokens),
          late_capacity_overrun_tokens: lateCapacityOverrunTokens,
          fast_reserve_breach_tokens: reserveBreachTokens,
        });
      }
      if (overrunTokens > 0) {
        logQuotaLifecycle("usage_overrun", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          plan_code: "free",
          execution_mode: reservation.executionMode,
          usage_overrun_tokens: overrunTokens,
        });
      }
      if (reserveBreachTokens > 0) {
        logQuotaLifecycle("fast_reserve_breach", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          plan_code: "free",
          execution_mode: reservation.executionMode,
          fast_reserve_breach_tokens: reserveBreachTokens,
        });
      }
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
    if (reservation.feature === "unified_text" && reservation.policyVersion === UNIFIED_TEXT_POLICY_VERSION) {
      const accounting = getTokenAllowanceAccounting(reservation.requestId);
      if (accounting && accounting.successfulCalls > 0) {
        closeTokenAllowanceAccounting({
          requestId: reservation.requestId,
          releasePending: true,
        });
        await this.commit(reservation, {
          request_lifecycle: "abnormal_termination",
          failure_release_reason: reason,
        });
        return;
      }
      closeTokenAllowanceAccounting({
        requestId: reservation.requestId,
        releasePending: true,
      });
      if (!reservation.reservationId) throw buildUnifiedTextUnavailableError();
      let result: any;
      try {
        result = await this.repository.releaseUnifiedTextTokensV2({
          reservationId: reservation.reservationId,
          requestId: reservation.requestId,
        });
      } catch (error) {
        logQuotaLifecycle("unified_text_v2_unavailable", {
          plan_policy: UNIFIED_TEXT_POLICY_VERSION,
          plan_code: "free",
          execution_mode: reservation.executionMode,
          request_lifecycle: "release",
          error_type: error instanceof BillingRepositoryError ? error.code : error instanceof Error ? error.name : "unknown",
        });
        throw buildUnifiedTextUnavailableError();
      }
      logQuotaLifecycle("unified_text_reservation_released", {
        plan_policy: UNIFIED_TEXT_POLICY_VERSION,
        plan_code: "free",
        execution_mode: reservation.executionMode,
        reserved_tokens: reservation.reservedUnits,
        released_tokens: normalizeNumber(result?.released_tokens, reservation.reservedUnits),
        failure_release_reason: reason,
        idempotent: normalizeBoolean(result?.idempotent),
        reason: typeof result?.reason === "string" ? result.reason : null,
      });
      return;
    }
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
