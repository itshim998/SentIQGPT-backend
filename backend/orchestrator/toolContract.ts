import { normalizeExecutionMode, type ExecutionMode } from "./executionProfile";

export type ModelOwnedToolName =
  | "web_surf"
  | "image_gen_basic"
  | "image_gen_advanced"
  | "intent_clarification_tool";

export interface ToolContract {
  readonly name: ModelOwnedToolName;
  readonly description: string;
  readonly allowedModes: readonly ExecutionMode[];
}

export const MODEL_OWNED_TOOL_CONTRACTS: readonly ToolContract[] = [
  {
    name: "web_surf",
    description: "Search live web sources for clearly current, recent, or real-time prompts.",
    allowedModes: ["fast", "intuitive"],
  },
  {
    name: "image_gen_basic",
    description: "Generate a basic image from an explicit image-generation prompt.",
    allowedModes: ["fast", "intuitive"],
  },
  {
    name: "image_gen_advanced",
    description: "Generate a complex image from an explicit image-generation prompt and entitlement-approved advanced model.",
    allowedModes: ["fast", "intuitive"],
  },
  {
    name: "intent_clarification_tool",
    description: "Ask a follow-up question only when ambiguity would materially change the answer.",
    allowedModes: ["intuitive"],
  },
];

const CONTRACT_BY_NAME = new Map<ModelOwnedToolName, ToolContract>(
  MODEL_OWNED_TOOL_CONTRACTS.map((contract) => [contract.name, contract]),
);

export function getAllowedModelOwnedTools(mode: ExecutionMode | undefined): readonly ModelOwnedToolName[] {
  const normalizedMode = normalizeExecutionMode(mode);
  return MODEL_OWNED_TOOL_CONTRACTS
    .filter((contract) => contract.allowedModes.includes(normalizedMode))
    .map((contract) => contract.name);
}

export function isModelOwnedToolAllowed(
  toolName: string,
  mode: ExecutionMode | undefined,
): toolName is ModelOwnedToolName {
  const contract = CONTRACT_BY_NAME.get(toolName as ModelOwnedToolName);
  if (!contract) return false;
  return contract.allowedModes.includes(normalizeExecutionMode(mode));
}

export function legacyRouteForModelOwnedTool(toolName: ModelOwnedToolName): string {
  switch (toolName) {
    case "web_surf":
      return "web_search";
    case "image_gen_basic":
    case "image_gen_advanced":
      return "image_generation";
    case "intent_clarification_tool":
      return "clarification";
    default:
      return "normal_chat";
  }
}
