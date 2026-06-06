import { createHmac, timingSafeEqual } from "crypto";
import { BillingRepository } from "../billingRepository";
import { getBillingMode, isBillingPlanCode } from "../planCatalog";
import type { BillingPlanCode } from "../entitlementTypes";
import type { CheckoutRequest, CheckoutResponse, PaymentProvider } from "./index";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is not configured`);
  return normalized;
}

function hasRazorpayConfig(planCode?: BillingPlanCode): boolean {
  if (!process.env.RAZORPAY_KEY_ID?.trim() || !process.env.RAZORPAY_KEY_SECRET?.trim()) return false;
  if (!planCode) return true;
  if (planCode === "student_core") return Boolean(process.env.RAZORPAY_PLAN_STUDENT_CORE?.trim());
  if (planCode === "premium") return Boolean(process.env.RAZORPAY_PLAN_PREMIUM?.trim());
  if (planCode === "pro") return Boolean(process.env.RAZORPAY_PLAN_PRO?.trim());
  return false;
}

function getRazorpayPlanId(planCode: BillingPlanCode): string {
  if (planCode === "student_core") return required(process.env.RAZORPAY_PLAN_STUDENT_CORE, "RAZORPAY_PLAN_STUDENT_CORE");
  if (planCode === "premium") return required(process.env.RAZORPAY_PLAN_PREMIUM, "RAZORPAY_PLAN_PREMIUM");
  if (planCode === "pro") return required(process.env.RAZORPAY_PLAN_PRO, "RAZORPAY_PLAN_PRO");
  throw new Error("Free plan does not use checkout");
}

function getBasicAuth(): string {
  const keyId = required(process.env.RAZORPAY_KEY_ID, "RAZORPAY_KEY_ID");
  const keySecret = required(process.env.RAZORPAY_KEY_SECRET, "RAZORPAY_KEY_SECRET");
  return Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

export class RazorpayProvider implements PaymentProvider {
  readonly gateway = "razorpay" as const;

  constructor(private readonly repository = new BillingRepository()) {}

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResponse> {
    const mode = getBillingMode();
    if (mode === "disabled") {
      return {
        mode,
        provider: "manual",
        status: "disabled",
        message: "Billing is coming soon. Everyone is currently on Free.",
      };
    }
    if (mode === "manual") {
      return {
        mode,
        provider: "manual",
        status: "manual",
        message: "Billing is in manual mode. Ask an admin to grant this plan.",
      };
    }
    if (!hasRazorpayConfig(request.planCode)) {
      return {
        mode,
        provider: "razorpay",
        status: "missing_configuration",
        message: "Checkout is not configured for this plan yet.",
      };
    }

    const response = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Basic ${getBasicAuth()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_id: getRazorpayPlanId(request.planCode),
        total_count: 120,
        customer_notify: 1,
        notes: {
          sentiq_user_id: request.userId,
          sentiq_plan_code: request.planCode,
          email: request.email ?? "",
        },
      }),
    });

    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Razorpay checkout failed: ${response.status}`);
    }

    const gatewaySubscriptionId = typeof payload.id === "string" ? payload.id : "";
    if (!gatewaySubscriptionId) {
      throw new Error("Razorpay checkout failed: missing subscription id");
    }

    await this.repository.upsertGatewaySubscription({
      userId: request.userId,
      planCode: request.planCode,
      status: "pending",
      gateway: "razorpay",
      gatewaySubscriptionId,
      gatewayPlanId: getRazorpayPlanId(request.planCode),
      metadata: { source: "checkout" },
    });

    return {
      mode,
      provider: "razorpay",
      status: "created",
      checkout: {
        key_id: process.env.RAZORPAY_KEY_ID,
        subscription_id: gatewaySubscriptionId,
        plan_code: request.planCode,
      },
    };
  }

  async verifyCheckout(payload: Record<string, unknown>): Promise<{ verified: boolean; gatewaySubscriptionId?: string; gatewayPaymentId?: string }> {
    const paymentId = typeof payload.razorpay_payment_id === "string" ? payload.razorpay_payment_id : "";
    const subscriptionId = typeof payload.razorpay_subscription_id === "string" ? payload.razorpay_subscription_id : "";
    const signature = typeof payload.razorpay_signature === "string" ? payload.razorpay_signature : "";
    if (!paymentId || !subscriptionId || !signature) return { verified: false };

    const expected = createHmac("sha256", required(process.env.RAZORPAY_KEY_SECRET, "RAZORPAY_KEY_SECRET"))
      .update(`${paymentId}|${subscriptionId}`)
      .digest("hex");
    return {
      verified: timingSafeSignatureCompare(expected, signature),
      gatewayPaymentId: paymentId,
      gatewaySubscriptionId: subscriptionId,
    };
  }

  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
    if (!secret || !signature) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return timingSafeSignatureCompare(expected, signature);
  }

  async handleWebhook(payload: Record<string, unknown>): Promise<{ processed: boolean; duplicate?: boolean }> {
    const eventType = typeof payload.event === "string" ? payload.event : "unknown";
    const gatewayEventId = typeof payload.id === "string" ? payload.id : null;
    const entityId = extractEntityId(payload);
    const recorded = await this.repository.recordBillingEvent({
      gateway: "razorpay",
      eventType,
      gatewayEventId,
      gatewayEntityId: entityId,
      raw: payload,
    });
    if (recorded.duplicate) return { processed: true, duplicate: true };

    const entity = extractSubscriptionEntity(payload);
    if (entity) {
      const notes = normalizeRecord(entity.notes);
      const userId = typeof notes.sentiq_user_id === "string" ? notes.sentiq_user_id : "";
      const planCode = typeof notes.sentiq_plan_code === "string" && isBillingPlanCode(notes.sentiq_plan_code)
        ? notes.sentiq_plan_code
        : null;
      const subscriptionId = typeof entity.id === "string" ? entity.id : "";
      if (userId && planCode && subscriptionId) {
        await this.repository.upsertGatewaySubscription({
          userId,
          planCode,
          status: normalizeRazorpaySubscriptionStatus(entity.status, eventType),
          gateway: "razorpay",
          gatewaySubscriptionId: subscriptionId,
          gatewayPlanId: typeof entity.plan_id === "string" ? entity.plan_id : null,
          gatewayCustomerId: typeof entity.customer_id === "string" ? entity.customer_id : null,
          currentPeriodStart: epochSecondsToIso(entity.current_start),
          currentPeriodEnd: epochSecondsToIso(entity.current_end),
          cancelAtPeriodEnd: Boolean(entity.cancel_at_cycle_end),
          metadata: { event_type: eventType },
        });
      }
    }

    return { processed: true };
  }

  async cancelSubscription(gatewaySubscriptionId: string): Promise<{ canceled: boolean; cancelAtPeriodEnd?: boolean }> {
    if (!gatewaySubscriptionId || !hasRazorpayConfig()) {
      return { canceled: false };
    }
    const response = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(gatewaySubscriptionId)}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${getBasicAuth()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cancel_at_cycle_end: 1 }),
    });
    if (!response.ok) {
      throw new Error(`Razorpay cancellation failed: ${response.status}`);
    }
    return { canceled: true, cancelAtPeriodEnd: true };
  }
}

function extractEntityId(payload: Record<string, unknown>): string | null {
  const entity = extractSubscriptionEntity(payload);
  if (typeof entity?.id === "string") return entity.id;
  return null;
}

function extractSubscriptionEntity(payload: Record<string, unknown>): Record<string, unknown> | null {
  const nested = payload.payload;
  if (!nested || typeof nested !== "object") return null;
  const record = nested as Record<string, unknown>;
  const subscription = normalizeRecord(record.subscription);
  const subscriptionEntity = normalizeRecord(subscription.entity);
  if (typeof subscriptionEntity.id === "string") return subscriptionEntity;

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const entity = (value as Record<string, unknown>).entity;
      if (entity && typeof entity === "object") {
        const normalized = entity as Record<string, unknown>;
        if (
          typeof normalized.id === "string"
          && (
            typeof normalized.plan_id === "string"
            || typeof normalized.current_start === "number"
            || typeof normalized.current_end === "number"
          )
        ) return normalized;
      }
    }
  }
  return null;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function epochSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function normalizeRazorpaySubscriptionStatus(rawStatus: unknown, eventType: string): string {
  const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
  if (eventType === "subscription.charged" || eventType === "subscription.activated") return "active";
  if (status === "active" || status === "authenticated") return "active";
  if (status === "created" || status === "pending") return "pending";
  if (status === "past_due" || status === "payment_failed") return "past_due";
  if (status === "halted") return "halted";
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (status === "completed" || status === "expired") return "expired";
  return "pending";
}

function timingSafeSignatureCompare(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
