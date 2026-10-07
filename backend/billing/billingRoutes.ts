import type { Express, NextFunction, Request, Response } from "express";
import { BillingRepository } from "./billingRepository";
import { RazorpayProvider } from "./paymentProviders/razorpayProvider";
import {
  getBillingMode,
  getPlanCatalog,
  getPlanByCode,
  isBillingPlanCode,
  TEXT_TOKEN_POLICY_VERSION,
  toPublicPlan,
} from "./planCatalog";
import { buildBillingIdentity } from "./anonymousIdentity";
import { BillingQuotaError, BillingQuotaService } from "./quotaService";
import type { BillingIdentity, BillingPlanCode } from "./entitlementTypes";
import { getRequestUser, verifyJWT } from "../middleware/auth";
import { getNemotronRolloutSnapshot } from "../nemotronRolloutFlags";

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

export function isIntuitiveQuotaUiPubliclyEnabled(): boolean {
  const rollout = getNemotronRolloutSnapshot();
  return rollout.unifiedTextTokensV2 && rollout.intuitiveQuotaUi;
}

function toFallbackUsageSummary(identity: BillingIdentity) {
  const plan = getPlanByCode(identity.userId ? "free" : "free");
  return {
    plan_code: plan.code,
    status: "disabled",
    quotas: Object.fromEntries(Object.entries(plan.entitlements.quotas)
      .filter(([, quota]) => Number.isFinite(quota.limit) && quota.limit < Number.MAX_SAFE_INTEGER)
      .map(([feature, quota]) => [
        feature,
        {
          label: quota.label,
          used: 0,
          reserved: 0,
          limit: quota.limit,
          remaining: quota.limit,
          window_seconds: quota.windowSeconds,
          window_start: null,
          reset_at: null,
          available: quota.limit > 0,
          ...(feature === "premium_text" || feature === "lite_text" ? {
            allowance_class: feature === "premium_text" ? "standard" : "lite",
            token_limit: quota.limit,
            tokens_consumed: 0,
            tokens_remaining: quota.limit,
            policy_version: TEXT_TOKEN_POLICY_VERSION,
          } : feature === "image_generation" ? {
            unit: "credits",
            label: "Image credits",
          } : {}),
        },
      ])),
  };
}

function parsePlanCode(value: unknown): BillingPlanCode | null {
  return typeof value === "string" && isBillingPlanCode(value) ? value : null;
}

function getAdminEmailSet(): Set<string> {
  return new Set(
    (process.env.SENTIQ_BILLING_ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function assertBillingAdmin(req: Request): void {
  const user = getRequestUser(req);
  const email = user.email?.trim().toLowerCase();
  if (!email || !getAdminEmailSet().has(email)) {
    const error = new Error("Billing admin access required.");
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
}

function allowsPermanentManualGrants(): boolean {
  return process.env.SENTIQ_BILLING_ALLOW_PERMANENT_MANUAL_GRANTS?.trim().toLowerCase() === "true";
}

function getRawBody(req: Request): Buffer | string {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (rawBody) return rawBody;
  return Buffer.from(JSON.stringify(req.body ?? {}));
}

function sendBillingProviderError(res: Response): void {
  res.status(503).json({
    error: "Billing checkout is unavailable right now. Please try again later.",
    code: "billing_provider_unavailable",
  });
}

export function registerBillingRoutes(app: Express): void {
  const repository = new BillingRepository();
  const quotaService = new BillingQuotaService(repository);
  const paymentProvider = new RazorpayProvider(repository);

  app.get("/api/billing/plans", asyncRoute(async (_req, res) => {
    try {
      const plans = await repository.listPlans();
      if (plans.length > 0) {
        res.json({ mode: getBillingMode(), plans });
        return;
      }
    } catch (error) {
      if (error instanceof BillingQuotaError) throw error;
      if (getNemotronRolloutSnapshot().unifiedTextTokensV2) throw error;
      if (getBillingMode() !== "disabled") throw error;
    }
    res.json({ mode: getBillingMode(), plans: getPlanCatalog().map(toPublicPlan) });
  }));

  app.get("/api/billing/me", verifyJWT({ allowGuest: true }), asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    const identity = buildBillingIdentity(req, user);
    if (!identity.userId && !identity.anonymousKeyHash) {
      res.status(400).json({ error: "Unable to identify quota session." });
      return;
    }

    const quotaUiEnabled = isIntuitiveQuotaUiPubliclyEnabled();
    try {
      const summary = await quotaService.getUsageSummary(identity);
      res.json({
        mode: getBillingMode(),
        quota_ui_enabled: quotaUiEnabled,
        identity: { is_guest: identity.isGuest },
        summary,
      });
      return;
    } catch (error) {
      if (getBillingMode() !== "disabled") throw error;
    }
    res.json({
      mode: getBillingMode(),
      quota_ui_enabled: quotaUiEnabled,
      identity: { is_guest: identity.isGuest },
      summary: toFallbackUsageSummary(identity),
    });
  }));

  app.get("/api/billing/usage", verifyJWT({ allowGuest: true }), asyncRoute(async (req, res) => {
    const identity = buildBillingIdentity(req, getRequestUser(req));
    const summary = await quotaService.getUsageSummary(identity);
    res.json({
      mode: getBillingMode(),
      quota_ui_enabled: isIntuitiveQuotaUiPubliclyEnabled(),
      summary,
    });
  }));

  app.post("/api/billing/checkout", verifyJWT({ allowGuest: false }), asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    const planCode = parsePlanCode(req.body?.plan_code);
    if (!planCode || planCode === "free") {
      res.status(400).json({ error: "Choose a paid plan to start checkout." });
      return;
    }

    await repository.upsertProfile({ userId: user.sub, email: user.email ?? null });
    let checkout;
    try {
      checkout = await paymentProvider.createCheckout({
        userId: user.sub,
        email: user.email ?? null,
        planCode,
      });
    } catch (error) {
      console.warn(`[Billing] checkout unavailable: ${error instanceof Error ? error.message : String(error)}`);
      sendBillingProviderError(res);
      return;
    }
    res.json({
      mode: checkout.mode,
      status: checkout.status,
      checkout: checkout.checkout ?? null,
      message: checkout.message ?? null,
    });
  }));

  app.post("/api/billing/verify", verifyJWT({ allowGuest: false }), asyncRoute(async (req, res) => {
    const result = await paymentProvider.verifyCheckout(req.body ?? {});
    res.json({
      verified: result.verified,
      subscription_id: result.gatewaySubscriptionId ?? null,
      payment_id: result.gatewayPaymentId ?? null,
      refresh_required: result.verified,
    });
  }));

  app.post("/api/billing/webhook/razorpay", asyncRoute(async (req, res) => {
    const signature = req.header("x-razorpay-signature") || req.header("razorpay_signature") || "";
    if (!paymentProvider.verifyWebhookSignature(getRawBody(req), signature)) {
      res.status(400).json({ error: "Invalid webhook signature." });
      return;
    }
    const result = await paymentProvider.handleWebhook(req.body ?? {});
    res.json({ processed: result.processed, duplicate: result.duplicate === true });
  }));

  app.post("/api/billing/cancel", verifyJWT({ allowGuest: false }), asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    const subscription = await repository.getCurrentSubscription(user.sub);
    if (!subscription?.gateway_subscription_id) {
      res.status(404).json({ error: "No active subscription found." });
      return;
    }
    let result;
    try {
      result = await paymentProvider.cancelSubscription(subscription.gateway_subscription_id);
    } catch (error) {
      console.warn(`[Billing] cancellation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      sendBillingProviderError(res);
      return;
    }
    if (result.canceled) {
      await repository.markCancelAtPeriodEnd(user.sub, subscription.id);
    }
    res.json({
      canceled: result.canceled,
      cancel_at_period_end: result.cancelAtPeriodEnd === true,
    });
  }));

  app.post("/api/admin/billing/grant-plan", verifyJWT({ allowGuest: false }), asyncRoute(async (req, res) => {
    assertBillingAdmin(req);
    const userId = typeof req.body?.user_id === "string" ? req.body.user_id.trim() : "";
    const planCode = parsePlanCode(req.body?.plan_code);
    const expiresAt = typeof req.body?.expires_at === "string" && req.body.expires_at.trim()
      ? req.body.expires_at.trim()
      : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "manual grant";
    if (!userId || !planCode) {
      res.status(400).json({ error: "user_id and plan_code are required." });
      return;
    }
    if (planCode !== "free" && !expiresAt && !allowsPermanentManualGrants()) {
      res.status(400).json({
        error: "expires_at is required for paid manual grants unless permanent manual grants are explicitly enabled.",
        code: "manual_grant_expiry_required",
      });
      return;
    }
    const result = await repository.grantPlan({ userId, planCode, expiresAt, reason });
    res.json({ granted: true, profile: result });
  }));
}
