import type { BillingPlanCode } from "../entitlementTypes";

export interface CheckoutRequest {
  readonly userId: string;
  readonly email?: string | null;
  readonly planCode: BillingPlanCode;
}

export interface CheckoutResponse {
  readonly mode: string;
  readonly provider: "manual" | "razorpay";
  readonly status: "disabled" | "manual" | "created" | "missing_configuration";
  readonly checkout?: Record<string, unknown>;
  readonly message?: string;
}

export interface PaymentProvider {
  readonly gateway: "manual" | "razorpay";
  createCheckout(request: CheckoutRequest): Promise<CheckoutResponse>;
  verifyCheckout(payload: Record<string, unknown>): Promise<{ verified: boolean; gatewaySubscriptionId?: string; gatewayPaymentId?: string }>;
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean;
  handleWebhook(payload: Record<string, unknown>): Promise<{ processed: boolean; duplicate?: boolean }>;
  cancelSubscription(gatewaySubscriptionId: string): Promise<{ canceled: boolean; cancelAtPeriodEnd?: boolean }>;
}
