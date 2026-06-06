import type { SupabaseClient } from "@supabase/supabase-js";
import { getControlDatabase } from "../dbRouter";
import { getPlanCatalog } from "./planCatalog";
import type { BillingIdentity, BillingPlanCode, BillableFeature } from "./entitlementTypes";

type SupabaseError = {
  readonly code?: string;
  readonly message?: string;
  readonly details?: string | null;
  readonly hint?: string | null;
} | null;

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

  async getUsageSummary(identity: BillingIdentity): Promise<any> {
    const { data, error } = await this.db.rpc("get_usage_summary", {
      p_user_id: identity.userId,
      p_anonymous_key_hash: identity.userId ? null : identity.anonymousKeyHash,
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to get usage summary: ${formatSupabaseError(error)}`);
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
    const { data, error } = await this.db.rpc("reserve_usage", {
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

  async commitReservation(args: {
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    readonly route: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<any> {
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

  async releaseReservation(requestId: string): Promise<void> {
    const { error } = await this.db.rpc("release_usage_reservation", {
      p_request_id: requestId,
    });
    if (error) {
      throw new BillingRepositoryError(`Failed to release usage reservation: ${formatSupabaseError(error)}`);
    }
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
