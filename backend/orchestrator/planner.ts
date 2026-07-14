// SentIQ Chat execution plan boundary.
//
// Automatic semantic tool choice belongs to the ordinary selected model. The
// server only creates a deterministic plan for explicit manual modes; every
// other request enters the conversation turn with the currently eligible tool
// registry attached.

import type { WebSearchMode } from "../tools/webSearch/webSearchMode";
import type { ExecutionMode } from "./executionProfile";

export type PlanTool =
  | "conversation"
  | "image_generation"
  | "file_analysis"
  | "memory_update"
  | "chart_generation"
  | "file_generation"
  | "web_search";

export interface PlanStep {
  readonly step: number;
  readonly tool: PlanTool;
  readonly input: string;
}

export interface ExecutionPlan {
  readonly steps: readonly PlanStep[];
}

function singleStep(tool: PlanTool, input: string): ExecutionPlan {
  return { steps: [{ step: 1, tool, input }] };
}

export async function planTask(args: {
  readonly userMessage: string;
  readonly hasFileContext?: boolean;
  readonly userId?: string;
  readonly explicitWebSearchMode?: WebSearchMode;
  readonly executionMode?: ExecutionMode;
}): Promise<ExecutionPlan> {
  void args.hasFileContext;
  void args.userId;
  void args.executionMode;

  if (args.explicitWebSearchMode) {
    return singleStep("web_search", args.userMessage);
  }

  return singleStep("conversation", args.userMessage);
}
