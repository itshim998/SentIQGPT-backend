import type { UsageReservation } from "../../billing/entitlementTypes";

type QuotaSettlementService = {
  commit: (reservation: UsageReservation, metadata?: Record<string, unknown>) => Promise<void>;
  release: (reservation: UsageReservation | null | undefined) => Promise<void>;
};

export type DeepResearchQuotaSettlement = "committed" | "released" | "already_settled";

/**
 * Enforces the Deep Research billing boundary:
 * - before Tavily accepts the request, reservations are releasable;
 * - after Tavily accepts it, reservations are always committed.
 *
 * The settled flag is set before the remote billing operation so a failed
 * commit can never fall through to a quota release.
 */
export class DeepResearchQuotaLifecycle {
  private providerAccepted = false;
  private settled = false;

  constructor(
    private readonly quotaService: QuotaSettlementService,
    private readonly reservation: UsageReservation,
  ) {}

  markProviderAccepted(): void {
    this.providerAccepted = true;
  }

  wasProviderAccepted(): boolean {
    return this.providerAccepted;
  }

  async settle(metadata: Record<string, unknown> = {}): Promise<DeepResearchQuotaSettlement> {
    if (this.settled) return "already_settled";
    this.settled = true;

    if (this.providerAccepted) {
      await this.quotaService.commit(this.reservation, metadata);
      return "committed";
    }

    await this.quotaService.release(this.reservation);
    return "released";
  }
}
