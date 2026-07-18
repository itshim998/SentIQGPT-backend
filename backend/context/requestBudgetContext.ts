import { AsyncLocalStorage } from "async_hooks";
import {
  estimateInputTokens,
  estimateTextTokens,
  normalizeContextPlanCode,
  type ContextPlanCode,
} from "../orchestrator/contextBudgetManager";
import { normalizeExecutionMode, type ExecutionMode } from "../orchestrator/executionProfile";

export interface TokenAllowanceAccounting {
  feature: "premium_text" | "lite_text";
  requestId: string;
  planCode: string;
  windowIdentity: string | null;
  reservedTokens: number;
  inputTokens: number;
  outputTokens: number;
  reportedCalls: number;
  estimatedCalls: number;
  successfulCalls: number;
}

export interface RequestBudgetContext {
  readonly planCode: ContextPlanCode;
  readonly executionMode: ExecutionMode;
  readonly resolution: "guest" | "billing" | "fallback" | "default";
  tokenAllowance?: TokenAllowanceAccounting;
}

const FREE_CONTEXT: RequestBudgetContext = { planCode: "free", executionMode: "fast", resolution: "default" };
const requestBudgetStorage = new AsyncLocalStorage<RequestBudgetContext>();

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
  readonly feature: "premium_text" | "lite_text";
  readonly requestId: string;
  readonly planCode: string;
  readonly windowIdentity?: string | null;
  readonly reservedTokens: number;
}): void {
  const context = requestBudgetStorage.getStore();
  if (!context) return;
  context.tokenAllowance = {
    feature: args.feature,
    requestId: args.requestId,
    planCode: args.planCode,
    windowIdentity: args.windowIdentity ?? null,
    reservedTokens: Math.max(0, Math.floor(args.reservedTokens)),
    inputTokens: 0,
    outputTokens: 0,
    reportedCalls: 0,
    estimatedCalls: 0,
    successfulCalls: 0,
  };
}

export function applyAffordableTokenCeiling(
  prompt: string,
  requestedOutputTokens: number,
): number {
  const accounting = requestBudgetStorage.getStore()?.tokenAllowance;
  if (!accounting) return requestedOutputTokens;
  const inputEstimate = estimateInputTokens(prompt).tokens;
  const spent = accounting.inputTokens + accounting.outputTokens;
  const affordableOutput = accounting.reservedTokens - spent - inputEstimate;
  if (affordableOutput < 32) {
    const error = new Error(`The ${accounting.feature === "lite_text" ? "Lite" : "Standard"} token reservation cannot support another model call.`);
    (error as Error & { code?: string }).code = "token_reservation_exhausted";
    throw error;
  }
  return Math.max(32, Math.min(Math.floor(requestedOutputTokens), affordableOutput));
}

export function recordSuccessfulModelUsage(args: {
  readonly prompt: string;
  readonly output: string;
  readonly reportedInputTokens?: number | null;
  readonly reportedOutputTokens?: number | null;
}): void {
  const accounting = requestBudgetStorage.getStore()?.tokenAllowance;
  if (!accounting) return;
  const hasReported = Number.isFinite(args.reportedInputTokens)
    && Number.isFinite(args.reportedOutputTokens)
    && Number(args.reportedInputTokens) >= 0
    && Number(args.reportedOutputTokens) >= 0;
  const inputTokens = hasReported
    ? Math.floor(Number(args.reportedInputTokens))
    : estimateInputTokens(args.prompt).tokens;
  const outputTokens = hasReported
    ? Math.floor(Number(args.reportedOutputTokens))
    : estimateTextTokens(args.output);
  accounting.inputTokens += inputTokens;
  accounting.outputTokens += outputTokens;
  accounting.successfulCalls += 1;
  if (hasReported) accounting.reportedCalls += 1;
  else accounting.estimatedCalls += 1;
}

export function getTokenAllowanceAccounting(requestId?: string): TokenAllowanceAccounting | null {
  const accounting = requestBudgetStorage.getStore()?.tokenAllowance;
  if (!accounting || (requestId && accounting.requestId !== requestId)) return null;
  return { ...accounting };
}
