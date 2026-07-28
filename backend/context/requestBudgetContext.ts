import { AsyncLocalStorage } from "async_hooks";
import {
  GenerationBudgetError,
  estimateInputTokens,
  estimateTextTokens,
  normalizeContextPlanCode,
  type ContextPlanCode,
} from "../orchestrator/contextBudgetManager";
import { normalizeExecutionMode, type ExecutionMode } from "../orchestrator/executionProfile";
import type { TextAllowanceClass } from "../billing/entitlementTypes";

export interface TokenAllowanceAccounting {
  feature?: "premium_text" | "lite_text";
  allowanceClass: TextAllowanceClass;
  policyVersion: string;
  requestId: string;
  planCode: string;
  windowIdentity: string | null;
  reservedTokens: number;
  inputTokens: number;
  outputTokens: number;
  pendingTokens: number;
  pendingCalls: number;
  futureReservedTokens: number;
  futureObligations: number;
  observedInputTokens: number;
  observedOutputTokens: number;
  usageOverrunTokens: number;
  closed: boolean;
  reportedCalls: number;
  estimatedCalls: number;
  successfulCalls: number;
}

export interface ModelCallReservation {
  readonly id: string;
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly totalReservedTokens: number;
}

export interface FutureTokenObligation {
  readonly id: string;
  readonly protectedInputTokens: number;
  readonly protectedOutputTokens: number;
  readonly totalReservedTokens: number;
}

interface MutableTokenAllowanceAccounting extends TokenAllowanceAccounting {
  nextReservationSequence: number;
  readonly pendingById: Map<string, ModelCallReservation>;
  readonly finalizedReservationIds: Set<string>;
  readonly futureById: Map<string, FutureTokenObligation>;
}

export interface RequestBudgetContext {
  readonly planCode: ContextPlanCode;
  readonly executionMode: ExecutionMode;
  readonly resolution: "guest" | "billing" | "fallback" | "default";
  tokenAllowance?: MutableTokenAllowanceAccounting;
}

const FREE_CONTEXT: RequestBudgetContext = { planCode: "free", executionMode: "fast", resolution: "default" };
const requestBudgetStorage = new AsyncLocalStorage<RequestBudgetContext>();

function allowanceError(accounting: TokenAllowanceAccounting): GenerationBudgetError {
  const allowanceLabel = accounting.allowanceClass === "unified_text"
    ? "Text"
    : accounting.allowanceClass === "lite"
      ? "Lite"
      : "Standard";
  return new GenerationBudgetError(
    `The ${allowanceLabel} token reservation cannot support another model call.`,
    "token_reservation_exhausted",
  );
}

function getMutableAccounting(): MutableTokenAllowanceAccounting | undefined {
  return requestBudgetStorage.getStore()?.tokenAllowance;
}

function committedTokens(accounting: TokenAllowanceAccounting): number {
  return Math.max(0, accounting.inputTokens + accounting.outputTokens);
}

function activeFutureTokens(
  accounting: MutableTokenAllowanceAccounting,
  consumeFutureObligationId?: string,
): number {
  const consumed = consumeFutureObligationId
    ? accounting.futureById.get(consumeFutureObligationId)?.totalReservedTokens ?? 0
    : 0;
  return Math.max(0, accounting.futureReservedTokens - consumed);
}

export function runWithRequestBudgetContext<T>(
  context: {
    readonly planCode: unknown;
    readonly executionMode?: unknown;
    readonly resolution: RequestBudgetContext["resolution"];
  },
  callback: () => T,
): T {
  return requestBudgetStorage.run({
    planCode: normalizeContextPlanCode(context.planCode),
    executionMode: normalizeExecutionMode(context.executionMode),
    resolution: context.resolution,
  }, callback);
}

export function getRequestBudgetContext(): RequestBudgetContext {
  return requestBudgetStorage.getStore() ?? FREE_CONTEXT;
}

export function attachTokenAllowanceAccounting(args: {
  readonly feature?: "premium_text" | "lite_text";
  readonly allowanceClass?: TextAllowanceClass;
  readonly policyVersion?: string;
  readonly requestId: string;
  readonly planCode: string;
  readonly windowIdentity?: string | null;
  readonly reservedTokens: number;
}): void {
  const context = requestBudgetStorage.getStore();
  if (!context) return;
  const allowanceClass = args.allowanceClass
    ?? (args.feature === "lite_text" ? "lite" : "standard");
  context.tokenAllowance = {
    feature: args.feature,
    allowanceClass,
    policyVersion: args.policyVersion ?? "standard-lite-tokens-v1",
    requestId: args.requestId,
    planCode: args.planCode,
    windowIdentity: args.windowIdentity ?? null,
    reservedTokens: Math.max(0, Math.floor(args.reservedTokens)),
    inputTokens: 0,
    outputTokens: 0,
    pendingTokens: 0,
    pendingCalls: 0,
    futureReservedTokens: 0,
    futureObligations: 0,
    observedInputTokens: 0,
    observedOutputTokens: 0,
    usageOverrunTokens: 0,
    closed: false,
    reportedCalls: 0,
    estimatedCalls: 0,
    successfulCalls: 0,
    nextReservationSequence: 1,
    pendingById: new Map(),
    finalizedReservationIds: new Set(),
    futureById: new Map(),
  };
}

/**
 * Balance available to a new call. A named future obligation is excluded when
 * that call is the final consumer, preventing the protected allocation from
 * being counted twice.
 */
export function getRemainingRequestReservationTokens(args: {
  readonly consumeFutureObligationId?: string;
} = {}): number | undefined {
  const accounting = getMutableAccounting();
  if (!accounting) return undefined;
  if (accounting.closed) return 0;
  return Math.max(
    0,
    accounting.reservedTokens
      - committedTokens(accounting)
      - accounting.pendingTokens
      - activeFutureTokens(accounting, args.consumeFutureObligationId),
  );
}

export function reserveFutureTokenObligation(args: {
  readonly id: string;
  readonly protectedInputTokens: number;
  readonly protectedOutputTokens: number;
}): FutureTokenObligation | null {
  const accounting = getMutableAccounting();
  if (!accounting) return null;
  if (accounting.closed) throw allowanceError(accounting);
  const existing = accounting.futureById.get(args.id);
  if (existing) return existing;
  if (accounting.finalizedReservationIds.has(`future:${args.id}`)) {
    throw new GenerationBudgetError("The protected final-answer allocation has already been consumed.");
  }

  const obligation: FutureTokenObligation = {
    id: args.id,
    protectedInputTokens: Math.max(0, Math.ceil(args.protectedInputTokens)),
    protectedOutputTokens: Math.max(0, Math.ceil(args.protectedOutputTokens)),
    totalReservedTokens: Math.max(0, Math.ceil(args.protectedInputTokens))
      + Math.max(0, Math.ceil(args.protectedOutputTokens)),
  };
  const remaining = getRemainingRequestReservationTokens() ?? 0;
  if (obligation.totalReservedTokens > remaining) throw new GenerationBudgetError();
  accounting.futureById.set(obligation.id, obligation);
  accounting.futureReservedTokens += obligation.totalReservedTokens;
  accounting.futureObligations = accounting.futureById.size;
  return obligation;
}

export function releaseFutureTokenObligation(id: string): boolean {
  const accounting = getMutableAccounting();
  if (!accounting) return false;
  const obligation = accounting.futureById.get(id);
  if (!obligation) return false;
  accounting.futureById.delete(id);
  accounting.futureReservedTokens = Math.max(
    0,
    accounting.futureReservedTokens - obligation.totalReservedTokens,
  );
  accounting.futureObligations = accounting.futureById.size;
  accounting.finalizedReservationIds.add(`future:${id}`);
  return true;
}

/**
 * Atomically reserve estimated input plus the provider completion allocation.
 * JavaScript execution cannot interleave within this synchronous mutation, so
 * concurrent Promise branches cannot observe the same unspent balance.
 */
export function reserveModelCall(args: {
  readonly estimatedInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly minimumOutputTokens?: number;
  readonly consumeFutureObligationId?: string;
}): ModelCallReservation | null {
  const accounting = getMutableAccounting();
  if (!accounting) return null;
  if (accounting.closed) throw allowanceError(accounting);
  const estimatedInputTokens = Math.max(0, Math.ceil(args.estimatedInputTokens));
  const requestedOutputTokens = Math.max(1, Math.floor(args.requestedOutputTokens));
  const minimumOutputTokens = Math.max(1, Math.floor(args.minimumOutputTokens ?? 32));
  const available = getRemainingRequestReservationTokens({
    consumeFutureObligationId: args.consumeFutureObligationId,
  }) ?? 0;
  const affordableOutputTokens = available - estimatedInputTokens;
  if (affordableOutputTokens < minimumOutputTokens) {
    if (args.consumeFutureObligationId) releaseFutureTokenObligation(args.consumeFutureObligationId);
    throw minimumOutputTokens > 32 ? new GenerationBudgetError() : allowanceError(accounting);
  }
  const reservedOutputTokens = Math.min(requestedOutputTokens, affordableOutputTokens);

  if (args.consumeFutureObligationId) {
    const obligation = accounting.futureById.get(args.consumeFutureObligationId);
    if (obligation) {
      accounting.futureById.delete(args.consumeFutureObligationId);
      accounting.futureReservedTokens = Math.max(
        0,
        accounting.futureReservedTokens - obligation.totalReservedTokens,
      );
      accounting.futureObligations = accounting.futureById.size;
      accounting.finalizedReservationIds.add(`future:${args.consumeFutureObligationId}`);
    }
  }

  const id = `${accounting.requestId}:model:${accounting.nextReservationSequence++}`;
  const reservation: ModelCallReservation = {
    id,
    estimatedInputTokens,
    reservedOutputTokens,
    totalReservedTokens: estimatedInputTokens + reservedOutputTokens,
  };
  accounting.pendingById.set(id, reservation);
  accounting.pendingTokens += reservation.totalReservedTokens;
  accounting.pendingCalls = accounting.pendingById.size;
  return reservation;
}

export function releaseModelCallReservation(reservationId: string | undefined): boolean {
  const accounting = getMutableAccounting();
  if (!accounting || !reservationId) return false;
  const reservation = accounting.pendingById.get(reservationId);
  if (!reservation) return false;
  accounting.pendingById.delete(reservationId);
  accounting.pendingTokens = Math.max(0, accounting.pendingTokens - reservation.totalReservedTokens);
  accounting.pendingCalls = accounting.pendingById.size;
  accounting.finalizedReservationIds.add(reservationId);
  return true;
}

export function closeTokenAllowanceAccounting(args: {
  readonly requestId: string;
  readonly releasePending?: boolean;
}): boolean {
  const accounting = getMutableAccounting();
  if (!accounting || accounting.requestId !== args.requestId) return false;
  if (accounting.closed) return true;
  if (args.releasePending) {
    accounting.pendingById.clear();
    accounting.pendingTokens = 0;
    accounting.pendingCalls = 0;
  } else if (accounting.pendingCalls > 0) {
    throw new Error("Cannot settle a token reservation while model calls are still pending.");
  }
  accounting.futureById.clear();
  accounting.futureReservedTokens = 0;
  accounting.futureObligations = 0;
  accounting.closed = true;
  return true;
}

function resolveUsage(args: {
  readonly prompt: string;
  readonly output: string;
  readonly reportedInputTokens?: number | null;
  readonly reportedOutputTokens?: number | null;
}): { inputTokens: number; outputTokens: number; reported: boolean } {
  const reported = Number.isFinite(args.reportedInputTokens)
    && Number.isFinite(args.reportedOutputTokens)
    && Number(args.reportedInputTokens) >= 0
    && Number(args.reportedOutputTokens) >= 0;
  return {
    inputTokens: reported
      ? Math.floor(Number(args.reportedInputTokens))
      : estimateInputTokens(args.prompt).tokens,
    outputTokens: reported
      ? Math.floor(Number(args.reportedOutputTokens))
      : estimateTextTokens(args.output),
    reported,
  };
}

function commitUsage(
  accounting: MutableTokenAllowanceAccounting,
  usage: { inputTokens: number; outputTokens: number; reported: boolean },
  maximumCommitTokens: number,
): void {
  const observedTotal = usage.inputTokens + usage.outputTokens;
  const committedTotal = Math.min(
    observedTotal,
    Math.max(0, maximumCommitTokens),
    Math.max(0, accounting.reservedTokens - committedTokens(accounting) - accounting.pendingTokens),
  );
  const committedInput = Math.min(usage.inputTokens, committedTotal);
  const committedOutput = Math.min(usage.outputTokens, committedTotal - committedInput);
  accounting.inputTokens += committedInput;
  accounting.outputTokens += committedOutput;
  accounting.observedInputTokens += usage.inputTokens;
  accounting.observedOutputTokens += usage.outputTokens;
  accounting.usageOverrunTokens += Math.max(0, observedTotal - committedTotal);
  accounting.successfulCalls += 1;
  if (usage.reported) accounting.reportedCalls += 1;
  else accounting.estimatedCalls += 1;
}

export function recordSuccessfulModelUsage(args: {
  readonly prompt: string;
  readonly output: string;
  readonly reportedInputTokens?: number | null;
  readonly reportedOutputTokens?: number | null;
  readonly reservationId?: string;
}): boolean {
  const accounting = getMutableAccounting();
  if (!accounting) return false;
  const usage = resolveUsage(args);
  if (args.reservationId) {
    const reservation = accounting.pendingById.get(args.reservationId);
    if (!reservation) return false;
    accounting.pendingById.delete(args.reservationId);
    accounting.pendingTokens = Math.max(0, accounting.pendingTokens - reservation.totalReservedTokens);
    accounting.pendingCalls = accounting.pendingById.size;
    accounting.finalizedReservationIds.add(args.reservationId);
    commitUsage(accounting, usage, reservation.totalReservedTokens);
    return true;
  }
  commitUsage(
    accounting,
    usage,
    Math.max(0, accounting.reservedTokens - committedTokens(accounting) - accounting.pendingTokens - accounting.futureReservedTokens),
  );
  return true;
}

/** Backward-compatible helper for legacy direct callers. */
export function applyAffordableTokenCeiling(
  prompt: string,
  requestedOutputTokens: number,
): number {
  const accounting = getMutableAccounting();
  if (!accounting) return requestedOutputTokens;
  const inputEstimate = estimateInputTokens(prompt).tokens;
  const remaining = getRemainingRequestReservationTokens() ?? 0;
  const affordableOutput = remaining - inputEstimate;
  if (affordableOutput < 32) throw allowanceError(accounting);
  return Math.max(32, Math.min(Math.floor(requestedOutputTokens), affordableOutput));
}

export function getTokenAllowanceAccounting(requestId?: string): TokenAllowanceAccounting | null {
  const accounting = getMutableAccounting();
  if (!accounting || (requestId && accounting.requestId !== requestId)) return null;
  return {
    feature: accounting.feature,
    allowanceClass: accounting.allowanceClass,
    policyVersion: accounting.policyVersion,
    requestId: accounting.requestId,
    planCode: accounting.planCode,
    windowIdentity: accounting.windowIdentity,
    reservedTokens: accounting.reservedTokens,
    inputTokens: accounting.inputTokens,
    outputTokens: accounting.outputTokens,
    pendingTokens: accounting.pendingTokens,
    pendingCalls: accounting.pendingCalls,
    futureReservedTokens: accounting.futureReservedTokens,
    futureObligations: accounting.futureObligations,
    observedInputTokens: accounting.observedInputTokens,
    observedOutputTokens: accounting.observedOutputTokens,
    usageOverrunTokens: accounting.usageOverrunTokens,
    closed: accounting.closed,
    reportedCalls: accounting.reportedCalls,
    estimatedCalls: accounting.estimatedCalls,
    successfulCalls: accounting.successfulCalls,
  };
}
