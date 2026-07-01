import { AsyncLocalStorage } from "async_hooks";
import { normalizeContextPlanCode, type ContextPlanCode } from "../orchestrator/contextBudgetManager";
import { normalizeExecutionMode, type ExecutionMode } from "../orchestrator/executionProfile";

export interface RequestBudgetContext {
  readonly planCode: ContextPlanCode;
  readonly executionMode: ExecutionMode;
  readonly resolution: "guest" | "billing" | "fallback" | "default";
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
