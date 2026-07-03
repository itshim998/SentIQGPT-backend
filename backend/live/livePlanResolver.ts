import type { BillingPlanCode } from "../billing/entitlementTypes";

type PlanTelemetryLogger = (
  event: string,
  details: Record<string, string | number | boolean | null>,
) => void;

function defaultLogger(event: string, details: Record<string, string | number | boolean | null>): void {
  console.warn(JSON.stringify({ scope: "sentiq_live", event, ...details }));
}

function normalizePlanCode(value: unknown): BillingPlanCode {
  return value === "student_core" || value === "premium" || value === "pro" ? value : "free";
}

export class LivePlanResolver {
  private readonly logger: PlanTelemetryLogger;

  constructor(
    private readonly resolvePlan: (userId: string) => Promise<unknown>,
    logger?: PlanTelemetryLogger,
  ) {
    this.logger = logger ?? defaultLogger;
  }

  async resolve(userId: string): Promise<BillingPlanCode> {
    try {
      return normalizePlanCode(await this.resolvePlan(userId));
    } catch (error) {
      this.logger("plan_resolution_failed", {
        fallback_plan: "free",
        error_type: error instanceof Error ? error.name : "unknown",
      });
      return "free";
    }
  }
}
