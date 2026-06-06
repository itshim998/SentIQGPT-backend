import type { BillingQuotaService } from "./quotaService";
import type { UsageReservation } from "./entitlementTypes";

export async function commitUsageAfterOutput(args: {
  readonly quotaService: BillingQuotaService;
  readonly reservation?: UsageReservation | null;
  readonly outputText?: string | null;
  readonly metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!args.reservation) return;
  const output = args.outputText ?? "";
  if (!output.trim()) {
    await args.quotaService.release(args.reservation);
    return;
  }
  await args.quotaService.commit(args.reservation, {
    estimated_output_chars: output.length,
    ...(args.metadata ?? {}),
  });
}

export async function releaseUsageOnProviderFailure(args: {
  readonly quotaService: BillingQuotaService;
  readonly reservation?: UsageReservation | null;
}): Promise<void> {
  await args.quotaService.release(args.reservation);
}
