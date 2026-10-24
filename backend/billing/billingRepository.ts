import type { SupabaseClient } from "@supabase/supabase-js";
import { getControlDatabase } from "../dbRouter";
import { getPlanCatalog, TEXT_TOKEN_POLICY_VERSION } from "./planCatalog";
import type { BillingIdentity, BillingPlanCode, BillableFeature } from "./entitlementTypes";
import type { ExecutionMode } from "../orchestrator/executionProfile";

type SupabaseError = {
  readonly code?: string;
  readonly message?: string;
  readonly details?: string | null;
  readonly hint?: string | null;
} | null;

const GUEST_TEXT_POLICY_VERSION = "guest-text-trial-v1";
const GUEST_TEXT_LIMIT_TOKENS = 8_000;

function formatSupabaseError(error: SupabaseError): string {
  if (!error) return "unknown";
  return [
    error.code ? `code=${error.code}` : null,
    error.message ? `message=${error.message}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ].filter(Boolean).join(" ") || "unknown";
}

function normalizeProviderPlanIds(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([, id]) => Boolean(id)));
}

function normalizeNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isGuestTextFeature(identity: BillingIdentity, feature: BillableFeature): boolean {
  return Boolean(
    identity.isGuest
      && !identity.userId
      && identity.anonymousKeyHash
      && (feature === "premium_text" || feature === "lite_text"),
  );
}

export class BillingRepositoryError extends Error {
  readonly code: string;

  constructor(message: string, code = "billing_repository_error") {
    super(message);
    this.name = "BillingRepositoryError";
    this.code = code;
  }
}

export class BillingRepository {
  constructor(private readonly db: SupabaseClient = getControlDatabase()) {}

  async seedPlans(): Promise<void> {
    for (const plan of getPlanCatalog()) {
      const { error } = await this.db
        .from("billing_plans")
        .upsert({
          code: plan.code,
          name: plan.name,
          description: plan.description,
          currency: plan.currency,
          price_paise: plan.pricePaise,
          interval: plan.interval,
          sort_order: plan.sortOrder,
          is_public: plan.isPublic,
          is_active: plan.isActive,
          provider_plan_ids: normalizeProviderPlanIds(plan.providerPlanIds),
          entitlements: {
            quotas: Object.fromEntries(Object.entries(plan.entitlements.quotas).map(([feature, quota]) => [
              feature,
              {
                limit: quota.limit,
                window_seconds: quota.windowSeconds,
                label: quota.label,
                ...(feature === "premium_text" || feature === "lite_text"
                  ? { policy_version: TEXT_TOKEN_POLICY_VERSION, unit: "tokens" }
                  : feature === "image_generation"
                  ? { unit: "credits" }
                  : { unit: "count" }),
              },
            ])),
            safe_labels: {
              premium_text: plan.entitlements.safeLabels.premiumText,
              lite_text: plan.entitlements.safeLabels.liteText,
              image_generation: plan.entitlements.safeLabels.image,
              text_image_generation: plan.entitlements.safeLabels.precisionImage,
            },
          },
        }, { onConflict: "code" });
      if (error) {
        throw new BillingRepositoryError(`Failed to seed billing plan ${plan.code}: ${formatSupabaseError(error)}`);
      }
    }
  }

  async listPlans(): Promise<any[]> {
    const { data, error } = await this.db
      .from("billing_plans")
      .select("code,name,description,currency,price_paise,interval,sort_order,is_public,is_active,entitlements")
      .eq("is_public", true)
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (error) {
      throw new BillingRepositoryError(`Failed to list billing plans: ${formatSupabaseError(error)}`);
    }
    return data ?? [];
  }

  async getGuestTextUsageSummary(anonymousKeyHash: string): Promise<any> {
    const { data, error } = await this.db.rpc("get_guest_text_usage_summary", {
      p_anonymous_key_hash: anonymousKeyHash,
    });
    if (error) {
      throw new BillingRepositoryError(
        `Guest text allowance is unavailable: ${formatSupabaseError(error)}`,
        "guest_text_quota_unavailable",
      );
    }
    return data;
  }

  async getEffectivePlan(userId: string): Promise<{
    plan_code: string;
    status: string;
    subscription_id: string | null;
    current_period_end: string | null;
  } | null> {
    const { data, error } = await this.db.rpc("get_effective_plan", {
      p_user_id: userId,
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to get effective plan: ${formatSupabaseError(error)}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row ?? null;
  }

  async getUsageSummary(identity: BillingIdentity): Promise<any> {
    const { data, error } = await this.db.rpc("get_usage_summary", {
      p_user_id: identity.userId,
      p_anonymous_key_hash: identity.userId ? null : identity.anonymousKeyHash,
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to get usage summary: ${formatSupabaseError(error)}`);
    }
    if (!identity.isGuest || identity.userId || !identity.anonymousKeyHash) return data;
    const guestTextAllowance = await this.getGuestTextUsageSummary(identity.anonymousKeyHash);
    return {
      ...(data ?? {}),
      guest_text_allowance: guestTextAllowance,
    };
  }

  async getUnifiedTextUsageSummaryV2(identity: BillingIdentity): Promise<any> {
    if (identity.isGuest && !identity.userId && identity.anonymousKeyHash) {
      const guest = await this.getGuestTextUsageSummary(identity.anonymousKeyHash);
      return {
        eligible: true,
        policy_version: GUEST_TEXT_POLICY_VERSION,
        plan_code: "free",
        limit_tokens: normalizeNumber(guest?.limit_tokens, GUEST_TEXT_LIMIT_TOKENS),
        window_seconds: 0,
        used_tokens: normalizeNumber(guest?.used_tokens),
        active_reserved_tokens: normalizeNumber(guest?.active_reserved_tokens),
        remaining_tokens: normalizeNumber(guest?.remaining_tokens),
        fast_reserve_tokens: 0,
        fast_available_tokens: normalizeNumber(guest?.remaining_tokens),
        intuitive_available_tokens: 0,
        intuitive_allowed: false,
        required_mode: "fast",
        exhausted: guest?.exhausted === true,
        next_recovery_at: null,
        full_reset_at: null,
        rollback_shadow_v1_standard_tokens: 0,
        rollback_shadow_v1_lite_tokens: 0,
      };
    }

    const { data, error } = await this.db.rpc("get_unified_text_usage_summary_v2", {
      p_user_id: identity.userId,
      p_anonymous_key_hash: identity.userId ? null : identity.anonymousKeyHash,
    });
    if (error) {
      throw new BillingRepositoryError(
        `Unified text-token V2 summary is unavailable: ${formatSupabaseError(error)}`,
        "unified_text_v2_unavailable",
      );
    }
    return data;
  }

  async reserveUsage(args: {
    readonly identity: BillingIdentity;
    readonly feature: BillableFeature;
    readonly units: number;
    readonly requestId: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<any> {
    if (isGuestTextFeature(args.identity, args.feature)) {
      const anonymousKeyHash = args.identity.anonymousKeyHash as string;
      const minimumTokens = Math.max(1, Math.trunc(normalizeNumber(args.metadata?.minimum_tokens, 256)));
      const { data, error } = await this.db.rpc("reserve_guest_text_tokens", {
        p_anonymous_key_hash: anonymousKeyHash,
        p_feature: args.feature,
        p_requested_tokens: args.units,
        p_minimum_tokens: minimumTokens,
        p_request_id: args.requestId,
        p_metadata: {
          ...(args.metadata ?? {}),
          guest_text_policy_version: GUEST_TEXT_POLICY_VERSION,
        },
      });
      if (error) {
        throw new BillingRepositoryError(
          `Guest text reservation is unavailable: ${formatSupabaseError(error)}`,
          "guest_text_quota_unavailable",
        );
      }
      return data;
    }

    const { data, error } = await this.db.rpc(args.metadata?.image_edit === true ? "reserve_image_edit_usage" : "reserve_usage", {
      p_user_id: args.identity.userId,
      p_anonymous_key_hash: args.identity.userId ? null : args.identity.anonymousKeyHash,
      p_feature: args.feature,
      p_units: args.units,
      p_request_id: args.requestId,
      p_metadata: args.metadata ?? {},
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to reserve usage: ${formatSupabaseError(error)}`);
    }
    return data;
  }

  async reserveUnifiedTextTokensV2(args: {
    readonly identity: BillingIdentity;
    readonly requestId: string;
    readonly executionMode: ExecutionMode;
    readonly requestedTokens: number;
    readonly minimumTokens: number;
    readonly metadata?: Record<string, unknown>;
  }): Promise<any> {
    // Guest chat deliberately stays on Fast and uses the isolated 8K guest
    // reservation path above. Returning plan_not_eligible for Fast makes the
    // quota service preserve the normal V1 request-budget lifecycle while the
    // repository supplies the guest-specific cap. Intuitive is rejected.
    if (args.identity.isGuest && !args.identity.userId && args.identity.anonymousKeyHash) {
      if (args.executionMode !== "fast") {
        const guest = await this.getGuestTextUsageSummary(args.identity.anonymousKeyHash);
        return {
          reserved: false,
          reason: "intuitive_fast_required",
          plan_code: "free",
          limit_tokens: normalizeNumber(guest?.limit_tokens, GUEST_TEXT_LIMIT_TOKENS),
          used_tokens: normalizeNumber(guest?.used_tokens),
          active_reserved_tokens: normalizeNumber(guest?.active_reserved_tokens),
          remaining_tokens: normalizeNumber(guest?.remaining_tokens),
          fast_reserve_tokens: 0,
          fast_available_tokens: normalizeNumber(guest?.remaining_tokens),
          intuitive_available_tokens: 0,
          required_mode: "fast",
          next_recovery_at: null,
        };
      }
      return {
        reserved: false,
        reason: "plan_not_eligible",
        plan_code: "free",
      };
    }

    const { data, error } = await this.db.rpc("reserve_unified_text_tokens_v2", {
      p_user_id: args.identity.userId,
      p_anonymous_key_hash: args.identity.userId ? null : args.identity.anonymousKeyHash,
      p_request_id: args.requestId,
      p_execution_mode: args.executionMode,
      p_requested_tokens: args.requestedTokens,
      p_minimum_tokens: args.minimumTokens,
      p_metadata: args.metadata ?? {},
    });
    if (error) {
      throw new BillingRepositoryError(
        `Unified text-token V2 reservation is unavailable: ${formatSupabaseError(error)}`,
        "unified_text_v2_unavailable",
      );
    }
    return data;
  }

  private async isGuestTextReservation(requestId: string): Promise<boolean | null> {
    if (!requestId || typeof (this.db as any)?.from !== "function") {
      return null;
    }
    let data: any;
    let error: any;
    try {
      const result = await this.db
        .from("quota_reservations")
        .select("user_id, metadata")
        .eq("request_id", requestId)
        .maybeSingle();
      data = result.data;
      error = result.error;
    } catch (err) {
      throw new BillingRepositoryError(
        `Failed to inspect quota reservation: ${err instanceof Error ? err.message : String(err)}`,
        "reservation_lookup_failed",
      );
    }

    if (error) {
      throw new BillingRepositoryError(
        `Failed to inspect quota reservation: ${formatSupabaseError(error)}`,
        "reservation_lookup_failed",
      );
    }

    if (!data) {
      return null;
    }
    const isGuest = !data.user_id;
    const metadata = data.metadata as Record<string, unknown> | null | undefined;
    const policyVersion = metadata?.quota_policy_version;
    const isGuestTrial = metadata?.guest_text_trial === true;
    return isGuest && (policyVersion === GUEST_TEXT_POLICY_VERSION || isGuestTrial);
  }

  async commitReservation(args: {
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    readonly route: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<any> {
    if (args.metadata?.image_edit === true) {
      const { data, error } = await this.db.rpc("commit_image_edit_usage", {
        p_request_id: args.requestId, p_provider: args.provider, p_model: args.model,
        p_route: args.route, p_metadata: args.metadata,
      });
      if (error || data?.committed !== true) throw new BillingRepositoryError("Image edit settlement is unavailable", "image_edit_settlement_failed");
      return data;
    }
    const isGuest = await this.isGuestTextReservation(args.requestId);
    const actualTokens = Math.max(1, Math.trunc(normalizeNumber(args.metadata?.actual_token_units, 1)));

    if (isGuest === true) {
      const { data, error } = await this.db.rpc("commit_guest_text_tokens", {
        p_request_id: args.requestId,
        p_reservation_id: null,
        p_actual_tokens: actualTokens,
        p_provider: args.provider,
        p_model: args.model,
        p_route: args.route,
        p_metadata: args.metadata ?? {},
      });
      if (error) {
        throw new BillingRepositoryError(
          `Guest text settlement is unavailable: ${formatSupabaseError(error)}`,
          "guest_text_quota_unavailable",
        );
      }
      if (data?.matched !== true) {
        throw new BillingRepositoryError("Guest text reservation could not be settled.", "guest_text_reservation_missing");
      }
      return data;
    }

    if (isGuest === false) {
      const { data, error } = await this.db.rpc("commit_usage_reservation", {
        p_request_id: args.requestId,
        p_provider: args.provider,
        p_model: args.model,
        p_route: args.route,
        p_metadata: args.metadata ?? {},
      });
      if (error) {
        throw new BillingRepositoryError(`Failed to commit usage reservation: ${formatSupabaseError(error)}`);
      }
      return data;
    }

    // isGuest is null (e.g. this.db.from is undefined in mock/test environments)
    const isGuestMetadata = args.metadata?.guest_text_trial === true
      || args.metadata?.quota_policy_version === GUEST_TEXT_POLICY_VERSION;

    if (isGuestMetadata) {
      const { data, error } = await this.db.rpc("commit_guest_text_tokens", {
        p_request_id: args.requestId,
        p_reservation_id: null,
        p_actual_tokens: actualTokens,
        p_provider: args.provider,
        p_model: args.model,
        p_route: args.route,
        p_metadata: args.metadata ?? {},
      });
      if (error) {
        throw new BillingRepositoryError(
          `Guest text settlement is unavailable: ${formatSupabaseError(error)}`,
          "guest_text_quota_unavailable",
        );
      }
      if (data?.matched !== true) {
        throw new BillingRepositoryError("Guest text reservation could not be settled.", "guest_text_reservation_missing");
      }
      return data;
    }

    // Fallback attempt for test mocks: try guest commit first; if matched, return; otherwise call commit_usage_reservation
    const { data: guestData, error: guestError } = await this.db.rpc("commit_guest_text_tokens", {
      p_request_id: args.requestId,
      p_reservation_id: null,
      p_actual_tokens: actualTokens,
      p_provider: args.provider,
      p_model: args.model,
      p_route: args.route,
      p_metadata: args.metadata ?? {},
    });
    if (!guestError && guestData?.matched === true) {
      return guestData;
    }

    const { data, error } = await this.db.rpc("commit_usage_reservation", {
      p_request_id: args.requestId,
      p_provider: args.provider,
      p_model: args.model,
      p_route: args.route,
      p_metadata: args.metadata ?? {},
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to commit usage reservation: ${formatSupabaseError(error)}`);
    }
    return data;
  }

  async commitUnifiedTextTokensV2(args: {
    readonly reservationId: string;
    readonly requestId: string;
    readonly actualTokens: number;
    readonly metadata?: Record<string, unknown>;
  }): Promise<any> {
    const { data, error } = await this.db.rpc("commit_unified_text_tokens_v2", {
      p_reservation_id: args.reservationId,
      p_request_id: args.requestId,
      p_actual_tokens: args.actualTokens,
      p_metadata: args.metadata ?? {},
    });
    if (error) {
      throw new BillingRepositoryError(
        `Unified text-token V2 settlement is unavailable: ${formatSupabaseError(error)}`,
        "unified_text_v2_unavailable",
      );
    }
    return data;
  }

  async releaseReservation(requestId: string): Promise<any> {
    const isGuest = await this.isGuestTextReservation(requestId);
    if (isGuest === true) {
      const { data, error } = await this.db.rpc("release_guest_text_tokens", {
        p_request_id: requestId,
        p_reservation_id: null,
      });
      if (error) {
        throw new BillingRepositoryError(
          `Guest text reservation release is unavailable: ${formatSupabaseError(error)}`,
          "guest_text_quota_unavailable",
        );
      }
      if (data?.matched !== true) {
        throw new BillingRepositoryError("Guest text reservation could not be released.", "guest_text_reservation_missing");
      }
      return data;
    }

    if (isGuest === false) {
      const { data, error } = await this.db.rpc("release_usage_reservation", {
        p_request_id: requestId,
      });
      if (error) {
        throw new BillingRepositoryError(`Failed to release usage reservation: ${formatSupabaseError(error)}`);
      }
      return data;
    }

    // isGuest is null (e.g. this.db.from is undefined in mock/test environments)
    const { data: guestData, error: guestError } = await this.db.rpc("release_guest_text_tokens", {
      p_request_id: requestId,
      p_reservation_id: null,
    });
    if (!guestError && guestData?.matched === true) {
      return guestData;
    }

    const { data, error } = await this.db.rpc("release_usage_reservation", {
      p_request_id: requestId,
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to release usage reservation: ${formatSupabaseError(error)}`);
    }
    return data;
  }

  async releaseUnifiedTextTokensV2(args: {
    readonly reservationId: string;
    readonly requestId: string;
  }): Promise<any> {
    const { data, error } = await this.db.rpc("release_unified_text_tokens_v2", {
      p_reservation_id: args.reservationId,
      p_request_id: args.requestId,
    });
    if (error) {
      throw new BillingRepositoryError(
        `Unified text-token V2 release is unavailable: ${formatSupabaseError(error)}`,
        "unified_text_v2_unavailable",
      );
    }
    return data;
  }

  async grantPlan(args: {
    readonly userId: string;
    readonly planCode: BillingPlanCode;
    readonly expiresAt?: string | null;
    readonly reason?: string;
  }): Promise<any> {
    const { data, error } = await this.db.rpc("admin_grant_plan", {
      p_user_id: args.userId,
      p_plan_code: args.planCode,
      p_expires_at: args.expiresAt ?? null,
      p_reason: args.reason ?? "manual grant",
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to grant billing plan: ${formatSupabaseError(error)}`);
    }
    return data;
  }

  async upsertGatewaySubscription(args: {
    readonly userId: string;
    readonly planCode: BillingPlanCode;
    readonly status: string;
    readonly gateway: string;
    readonly gatewaySubscriptionId: string;
    readonly gatewayPlanId?: string | null;
    readonly gatewayCustomerId?: string | null;
    readonly currentPeriodStart?: string | null;
    readonly currentPeriodEnd?: string | null;
    readonly cancelAtPeriodEnd?: boolean;
    readonly metadata?: Record<string, unknown>;
  }): Promise<any> {
    const { data, error } = await this.db
      .from("user_subscriptions")
      .upsert({
        user_id: args.userId,
        plan_code: args.planCode,
        status: args.status,
        gateway: args.gateway,
        gateway_subscription_id: args.gatewaySubscriptionId,
        gateway_plan_id: args.gatewayPlanId ?? null,
        gateway_customer_id: args.gatewayCustomerId ?? null,
        current_period_start: args.currentPeriodStart ?? null,
        current_period_end: args.currentPeriodEnd ?? null,
        cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
        metadata: args.metadata ?? {},
        updated_at: new Date().toISOString(),
      }, { onConflict: "gateway,gateway_subscription_id" })
      .select("id,user_id,plan_code,status,gateway_subscription_id,current_period_end,cancel_at_period_end")
      .single();

    if (error) {
      throw new BillingRepositoryError(`Failed to upsert billing subscription: ${formatSupabaseError(error)}`);
    }

    await this.setProfileSubscription({
      userId: args.userId,
      planCode: args.status === "active" ? args.planCode : "free",
      status: args.status,
      subscriptionId: data?.id ?? null,
    });

    return data;
  }

  async getCurrentSubscription(userId: string): Promise<any | null> {
    const { data: profile, error: profileError } = await this.db
      .from("user_billing_profiles")
      .select("current_subscription_id,current_plan_code,effective_status")
      .eq("user_id", userId)
      .maybeSingle();
    if (profileError) {
      throw new BillingRepositoryError(`Failed to load billing profile: ${formatSupabaseError(profileError)}`);
    }
    if (!profile?.current_subscription_id) return null;

    const { data, error } = await this.db
      .from("user_subscriptions")
      .select("id,user_id,plan_code,status,gateway,gateway_subscription_id,current_period_end,cancel_at_period_end")
      .eq("id", profile.current_subscription_id)
      .maybeSingle();
    if (error) {
      throw new BillingRepositoryError(`Failed to load billing subscription: ${formatSupabaseError(error)}`);
    }
    return data ?? null;
  }

  async markCancelAtPeriodEnd(userId: string, subscriptionId: string): Promise<void> {
    const { error } = await this.db
      .from("user_subscriptions")
      .update({
        cancel_at_period_end: true,
        status: "canceling",
        updated_at: new Date().toISOString(),
      })
      .eq("id", subscriptionId)
      .eq("user_id", userId);
    if (error) {
      throw new BillingRepositoryError(`Failed to mark subscription cancellation: ${formatSupabaseError(error)}`);
    }
  }

  async recordBillingEvent(args: {
    readonly gateway: string;
    readonly eventType: string;
    readonly gatewayEventId?: string | null;
    readonly gatewayEntityId?: string | null;
    readonly raw: Record<string, unknown>;
  }): Promise<{ duplicate: boolean }> {
    const { error } = await this.db
      .from("billing_events")
      .insert({
        gateway: args.gateway,
        event_type: args.eventType,
        gateway_event_id: args.gatewayEventId ?? null,
        gateway_entity_id: args.gatewayEntityId ?? null,
        raw: args.raw,
        processed_at: new Date().toISOString(),
      });
    if (!error) return { duplicate: false };
    if (error.code === "23505") return { duplicate: true };
    throw new BillingRepositoryError(`Failed to record billing event: ${formatSupabaseError(error)}`);
  }

  async upsertProfile(args: {
    readonly userId: string;
    readonly email?: string | null;
    readonly displayName?: string | null;
  }): Promise<void> {
    const { error } = await this.db
      .from("user_billing_profiles")
      .upsert({
        user_id: args.userId,
        email: args.email ?? null,
        display_name: args.displayName ?? null,
      }, { onConflict: "user_id", ignoreDuplicates: false });
    if (error) {
      throw new BillingRepositoryError(`Failed to upsert billing profile: ${formatSupabaseError(error)}`);
    }
  }

  private async setProfileSubscription(args: {
    readonly userId: string;
    readonly planCode: BillingPlanCode;
    readonly status: string;
    readonly subscriptionId?: string | null;
  }): Promise<void> {
    const { error } = await this.db
      .from("user_billing_profiles")
      .upsert({
        user_id: args.userId,
        current_plan_code: args.planCode,
        effective_status: args.status,
        current_subscription_id: args.subscriptionId ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id", ignoreDuplicates: false });
    if (error) {
      throw new BillingRepositoryError(`Failed to update billing profile subscription: ${formatSupabaseError(error)}`);
    }
  }
}
