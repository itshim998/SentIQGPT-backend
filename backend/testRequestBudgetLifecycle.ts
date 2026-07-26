import assert from "node:assert/strict";
import {
  attachTokenAllowanceAccounting,
  closeTokenAllowanceAccounting,
  getRemainingRequestReservationTokens,
  getTokenAllowanceAccounting,
  recordSuccessfulModelUsage,
  releaseFutureTokenObligation,
  releaseModelCallReservation,
  reserveFutureTokenObligation,
  reserveModelCall,
  runWithRequestBudgetContext,
} from "./context/requestBudgetContext";
import { GenerationBudgetError } from "./orchestrator/contextBudgetManager";

async function withAllowance(
  requestId: string,
  reservedTokens: number,
  run: () => void | Promise<void>,
): Promise<void> {
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "intuitive", resolution: "billing" },
    async () => {
      attachTokenAllowanceAccounting({
        feature: "premium_text",
        requestId,
        planCode: "free",
        reservedTokens,
      });
      await run();
    },
  );
}

function accounting(requestId: string) {
  const value = getTokenAllowanceAccounting(requestId);
  assert(value);
  return value;
}

async function main(): Promise<void> {
  await withAllowance("exact-worked-example", 7_000, () => {
    const call = reserveModelCall({
      estimatedInputTokens: 2_200,
      requestedOutputTokens: 6_000,
      minimumOutputTokens: 1_500,
    });
    assert(call);
    assert.equal(call.reservedOutputTokens, 4_800);
    assert.equal(call.totalReservedTokens, 7_000);
    assert.equal(accounting("exact-worked-example").pendingTokens, 7_000);
    assert.equal(releaseModelCallReservation(call.id), true);
    assert.equal(releaseModelCallReservation(call.id), false, "release is idempotent");
    assert.equal(accounting("exact-worked-example").pendingTokens, 0);
  });

  await withAllowance("exact-floor", 3_700, () => {
    const call = reserveModelCall({
      estimatedInputTokens: 2_200,
      requestedOutputTokens: 6_000,
      minimumOutputTokens: 1_500,
    });
    assert(call);
    assert.equal(call.reservedOutputTokens, 1_500);
    releaseModelCallReservation(call.id);
  });
  await withAllowance("below-floor", 3_699, () => {
    assert.throws(
      () => reserveModelCall({
        estimatedInputTokens: 2_200,
        requestedOutputTokens: 6_000,
        minimumOutputTokens: 1_500,
      }),
      GenerationBudgetError,
    );
    assert.equal(accounting("below-floor").pendingCalls, 0);
  });

  await withAllowance("future-fits", 8_000, () => {
    const future = reserveFutureTokenObligation({
      id: "final",
      protectedInputTokens: 2_200,
      protectedOutputTokens: 1_500,
    });
    assert(future);
    const supporting = reserveModelCall({
      estimatedInputTokens: 200,
      requestedOutputTokens: 1_000,
    });
    assert(supporting);
    assert.equal(supporting.reservedOutputTokens, 1_000);
    assert.equal(accounting("future-fits").futureReservedTokens, 3_700);
    releaseModelCallReservation(supporting.id);
    assert.equal(releaseFutureTokenObligation("final"), true);
    assert.equal(releaseFutureTokenObligation("final"), false);
  });

  await withAllowance("future-reduces", 5_000, () => {
    reserveFutureTokenObligation({
      id: "final",
      protectedInputTokens: 2_200,
      protectedOutputTokens: 1_500,
    });
    const supporting = reserveModelCall({
      estimatedInputTokens: 200,
      requestedOutputTokens: 2_000,
    });
    assert(supporting);
    assert.equal(supporting.reservedOutputTokens, 1_100);
    releaseModelCallReservation(supporting.id);
    releaseFutureTokenObligation("final");
  });

  await withAllowance("future-rejects", 3_900, () => {
    reserveFutureTokenObligation({
      id: "final",
      protectedInputTokens: 2_200,
      protectedOutputTokens: 1_500,
    });
    assert.throws(
      () => reserveModelCall({
        estimatedInputTokens: 200,
        requestedOutputTokens: 100,
      }),
      GenerationBudgetError,
    );
    assert.equal(accounting("future-rejects").pendingCalls, 0);
    releaseFutureTokenObligation("final");
  });

  await withAllowance("future-consumed", 8_000, () => {
    reserveFutureTokenObligation({
      id: "final",
      protectedInputTokens: 2_200,
      protectedOutputTokens: 1_500,
    });
    const supporting = reserveModelCall({
      estimatedInputTokens: 200,
      requestedOutputTokens: 600,
    });
    assert(supporting);
    recordSuccessfulModelUsage({
      reservationId: supporting.id,
      prompt: "support",
      output: "selected tool",
      reportedInputTokens: 200,
      reportedOutputTokens: 100,
    });
    const final = reserveModelCall({
      estimatedInputTokens: 2_200,
      requestedOutputTokens: 6_000,
      minimumOutputTokens: 1_500,
      consumeFutureObligationId: "final",
    });
    assert(final);
    assert.equal(final.reservedOutputTokens, 5_500);
    assert.equal(accounting("future-consumed").futureReservedTokens, 0);
    assert.equal(accounting("future-consumed").futureObligations, 0);
    recordSuccessfulModelUsage({
      reservationId: final.id,
      prompt: "bounded evidence",
      output: "final answer",
      reportedInputTokens: 2_000,
      reportedOutputTokens: 1_000,
    });
    const settled = accounting("future-consumed");
    assert.equal(settled.pendingTokens, 0);
    assert.equal(settled.pendingCalls, 0);
    assert.equal(settled.successfulCalls, 2);
  });

  await withAllowance("cancellation-cleanup", 6_000, () => {
    reserveFutureTokenObligation({
      id: "final",
      protectedInputTokens: 1_000,
      protectedOutputTokens: 1_500,
    });
    assert.equal(releaseFutureTokenObligation("final"), true);
    const pending = reserveModelCall({
      estimatedInputTokens: 500,
      requestedOutputTokens: 2_000,
    });
    assert(pending);
    assert.equal(releaseModelCallReservation(pending.id), true);
    const cleaned = accounting("cancellation-cleanup");
    assert.equal(cleaned.pendingTokens, 0);
    assert.equal(cleaned.futureReservedTokens, 0);
  });

  await withAllowance("pre-provider-failure", 6_000, () => {
    reserveFutureTokenObligation({
      id: "final",
      protectedInputTokens: 1_000,
      protectedOutputTokens: 1_500,
    });
    const final = reserveModelCall({
      estimatedInputTokens: 1_000,
      requestedOutputTokens: 4_000,
      minimumOutputTokens: 1_500,
      consumeFutureObligationId: "final",
    });
    assert(final);
    assert.equal(releaseModelCallReservation(final.id), true);
    const cleaned = accounting("pre-provider-failure");
    assert.equal(cleaned.pendingTokens, 0);
    assert.equal(cleaned.futureReservedTokens, 0);
    assert.equal(cleaned.successfulCalls, 0);
  });

  await withAllowance("parallel", 4_000, async () => {
    const reserve = async () => reserveModelCall({
      estimatedInputTokens: 700,
      requestedOutputTokens: 1_800,
    });
    const [first, second] = await Promise.all([reserve(), reserve()]);
    assert(first && second);
    assert.equal(first.reservedOutputTokens, 1_800);
    assert.equal(second.reservedOutputTokens, 800, "second overlapping call is capped");
    const pending = accounting("parallel");
    assert.equal(pending.pendingTokens, 4_000);
    assert.equal(pending.pendingCalls, 2);
    assert(pending.pendingTokens + pending.inputTokens + pending.outputTokens <= pending.reservedTokens);
    releaseModelCallReservation(first.id);
    releaseModelCallReservation(second.id);
    assert.equal(accounting("parallel").pendingTokens, 0);
  });

  await withAllowance("settlement-closure", 4_000, () => {
    reserveFutureTokenObligation({
      id: "unused-final",
      protectedInputTokens: 500,
      protectedOutputTokens: 1_500,
    });
    assert.equal(closeTokenAllowanceAccounting({ requestId: "settlement-closure" }), true);
    const closed = accounting("settlement-closure");
    assert.equal(closed.closed, true);
    assert.equal(closed.futureReservedTokens, 0);
    assert.throws(
      () => reserveModelCall({
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      }),
      GenerationBudgetError,
      "late background model work cannot start after settlement",
    );
  });

  await withAllowance("reported-and-estimated", 10_000, () => {
    const reported = reserveModelCall({
      estimatedInputTokens: 500,
      requestedOutputTokens: 2_000,
    });
    assert(reported);
    recordSuccessfulModelUsage({
      reservationId: reported.id,
      prompt: "provider prompt",
      output: "visible output",
      reportedInputTokens: 450,
      reportedOutputTokens: 1_250,
    });
    const estimated = reserveModelCall({
      estimatedInputTokens: 500,
      requestedOutputTokens: 1_000,
    });
    assert(estimated);
    recordSuccessfulModelUsage({
      reservationId: estimated.id,
      prompt: "estimated provider prompt",
      output: "estimated provider output",
    });
    const usage = accounting("reported-and-estimated");
    assert.equal(usage.reportedCalls, 1);
    assert.equal(usage.estimatedCalls, 1);
    assert.equal(usage.observedOutputTokens >= 1_250, true);
    assert.equal(usage.pendingCalls, 0);
  });

  await withAllowance("continuation-repair", 4_500, () => {
    const initial = reserveModelCall({
      estimatedInputTokens: 500,
      requestedOutputTokens: 2_500,
    });
    assert(initial);
    recordSuccessfulModelUsage({
      reservationId: initial.id,
      prompt: "initial",
      output: "partial answer",
      reportedInputTokens: 500,
      reportedOutputTokens: 1_500,
    });
    assert.equal(getRemainingRequestReservationTokens(), 2_500);
    const continuation = reserveModelCall({
      estimatedInputTokens: 700,
      requestedOutputTokens: 1_800,
      minimumOutputTokens: 128,
    });
    assert(continuation);
    assert.equal(continuation.reservedOutputTokens, 1_800);
    recordSuccessfulModelUsage({
      reservationId: continuation.id,
      prompt: "continuation with answer so far",
      output: "continued answer",
      reportedInputTokens: 650,
      reportedOutputTokens: 800,
    });
    const repair = reserveModelCall({
      estimatedInputTokens: 500,
      requestedOutputTokens: 1_000,
      minimumOutputTokens: 128,
    });
    assert(repair);
    assert.equal(repair.reservedOutputTokens, 550, "repair is reduced by all prior usage");
    releaseModelCallReservation(repair.id);
    assert.throws(
      () => reserveModelCall({
        estimatedInputTokens: 950,
        requestedOutputTokens: 1_000,
        minimumOutputTokens: 128,
      }),
      GenerationBudgetError,
    );
    const final = accounting("continuation-repair");
    assert(final.inputTokens + final.outputTokens + final.pendingTokens <= final.reservedTokens);
  });

  console.log("Request budget lifecycle tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
