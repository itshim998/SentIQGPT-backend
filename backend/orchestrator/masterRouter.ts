import {
  callLLMAdapterDetailed,
  strictParseJsonObject,
  type LLMAdapterCall,
  type LLMAdapterResult,
} from "../ai/PromptBuilders";
import { detectPromptComplexity } from "../tools/imageGeneration/imageRouter";
import { normalizeExecutionMode, type ExecutionMode } from "./executionProfile";
import { selectModelForPrompt } from "./modelRouter";

export type MasterModelName =
  | "general_model"
  | "reasoning_specialist"
  | "basic_image_generator"
  | "advanced_image_generator"
  | "coding_specialist"
  | "file_generator";

export interface MasterRoutingDecision {
  readonly selected_model: MasterModelName;
  readonly confidence: number;
  readonly reason: string;
}

export interface MasterRoutingResult {
  readonly model: string;
  readonly source: "master" | "deterministic";
  readonly master_model?: MasterModelName;
  readonly confidence?: number;
  readonly reason?: string;
  readonly fallback_reason?: string;
}

export type ImageModelPreference = "zimage" | "wan-image";

export const VALID_MASTER_MODELS: ReadonlySet<string> = new Set<MasterModelName>([
  "general_model",
  "reasoning_specialist",
  "basic_image_generator",
  "advanced_image_generator",
  "coding_specialist",
  "file_generator",
]);

export const MASTER_MODEL_TO_EXECUTION_MODEL: Record<MasterModelName, string> = {
  general_model: "gpt-oss-120b",
  reasoning_specialist: "openai-large",
  basic_image_generator: "zimage",
  advanced_image_generator: "wan-image",
  coding_specialist: "qwen-coder",
  file_generator: "minimax",
};

const MASTER_ROUTER_MODEL =
  process.env.MASTER_ROUTER_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const HIGH_CONFIDENCE_THRESHOLD = 0.6;
const ADVISORY_CONFIDENCE_THRESHOLD = 0.4;
const CHAT_COMPATIBLE_MODELS = new Set(["gpt-oss-120b", "openai-large", "qwen-coder"]);

interface RouterOptions {
  readonly hasImage?: boolean;
  readonly hasFile?: boolean;
  readonly fileContent?: string;
  readonly fileNames?: string[];
}

interface MasterSelectionArgs {
  readonly query: string;
  readonly classification?: string;
  readonly options?: RouterOptions;
  readonly executionMode?: ExecutionMode;
  readonly userId?: string;
  readonly isGuest?: boolean;
  readonly signal?: AbortSignal;
}

interface ImageSelectionArgs {
  readonly prompt: string;
  readonly executionMode?: ExecutionMode;
  readonly userId?: string;
  readonly isGuest?: boolean;
  readonly signal?: AbortSignal;
}

interface MasterRouterDependencies {
  readonly callModel?: (call: LLMAdapterCall) => Promise<LLMAdapterResult>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMasterRouterDisabledReason(args: {
  readonly executionMode?: ExecutionMode;
  readonly userId?: string;
  readonly isGuest?: boolean;
}): string | null {
  if (normalizeExecutionMode(args.executionMode) !== "intuitive") {
    return "master_router_fast_mode";
  }
  if (args.isGuest === true || args.userId === "guest") {
    return "master_router_guest";
  }
  if ((process.env.MASTER_ROUTER_ENABLED || "true").toLowerCase() === "false") {
    return "master_router_disabled";
  }
  return null;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function validateMasterRoutingDecision(value: unknown): MasterRoutingDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const selectedModel = typeof record.selected_model === "string" ? record.selected_model : "";
  if (!VALID_MASTER_MODELS.has(selectedModel)) {
    return null;
  }

  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) {
    return null;
  }

  const reason = typeof record.reason === "string" && record.reason.trim()
    ? record.reason.replace(/\s+/g, " ").trim().slice(0, 180)
    : "Master routing decision";

  return {
    selected_model: selectedModel as MasterModelName,
    confidence: clampConfidence(record.confidence),
    reason,
  };
}

function buildMasterRoutingPrompt(args: {
  readonly userPrompt: string;
  readonly executionContext: "chat_or_file_analysis" | "image_generation";
  readonly hasFile?: boolean;
  readonly hasImage?: boolean;
}): string {
  return [
    "Analyze the following user request and determine the best model.",
    "",
    "You are selecting a specialized model only. Do not answer the user.",
    `Execution context: ${args.executionContext}`,
    `Has uploaded file context: ${args.hasFile ? "yes" : "no"}`,
    `Has image attachment context: ${args.hasImage ? "yes" : "no"}`,
    "",
    "Available model names:",
    "- general_model",
    "- reasoning_specialist",
    "- basic_image_generator",
    "- advanced_image_generator",
    "- coding_specialist",
    "- file_generator",
    "",
    "Rules:",
    "- Prefer the cheapest sufficient model.",
    "- Escalate only when complexity genuinely requires it.",
    "- For image generation, use advanced_image_generator for text rendering, posters, infographics, spatial composition, or complex scenes.",
    "- For code writing, debugging, architecture, APIs, algorithms, or technical implementation, use coding_specialist.",
    "- For advanced math, proofs, complex reasoning, or research-level analysis, use reasoning_specialist.",
    "- For ordinary conversation and general knowledge, use general_model.",
    "",
    "User Request:",
    args.userPrompt,
    "",
    "Return STRICT JSON ONLY in this format:",
    '{"selected_model":"model_name","confidence":0.0,"reason":"short reason"}',
  ].join("\n");
}

async function requestMasterDecision(
  args: {
    readonly prompt: string;
    readonly executionContext: "chat_or_file_analysis" | "image_generation";
    readonly hasFile?: boolean;
    readonly hasImage?: boolean;
    readonly userId?: string;
    readonly signal?: AbortSignal;
  },
  dependencies: MasterRouterDependencies = {},
): Promise<MasterRoutingDecision> {
  const callModel = dependencies.callModel ?? callLLMAdapterDetailed;
  const result = await callModel({
    task: "master_route",
    prompt: buildMasterRoutingPrompt({
      userPrompt: args.prompt,
      executionContext: args.executionContext,
      hasFile: args.hasFile,
      hasImage: args.hasImage,
    }),
    prefer: "groq",
    model_override: MASTER_ROUTER_MODEL,
    user_id: args.userId,
    timeout_ms: parsePositiveInt(process.env.MASTER_ROUTER_TIMEOUT_MS, 3500),
    max_output_tokens: 200,
    skip_wrappers: true,
    signal: args.signal,
  });

  const parsed = strictParseJsonObject(result.text);
  const decision = validateMasterRoutingDecision(parsed);
  if (!decision) {
    throw new Error("Invalid Master routing response");
  }
  return decision;
}

function isHighConfidence(decision: MasterRoutingDecision): boolean {
  return decision.confidence >= HIGH_CONFIDENCE_THRESHOLD;
}

function isAdvisoryConfidence(decision: MasterRoutingDecision): boolean {
  return decision.confidence >= ADVISORY_CONFIDENCE_THRESHOLD
    && decision.confidence < HIGH_CONFIDENCE_THRESHOLD;
}

function isCompatibleChatModel(
  deterministicModel: string,
  mappedModel: string,
  options?: RouterOptions,
): boolean {
  if (!CHAT_COMPATIBLE_MODELS.has(mappedModel)) {
    return false;
  }

  if (options?.hasImage) {
    return false;
  }

  if (options?.hasFile && deterministicModel === "gemini-search") {
    return false;
  }

  if (deterministicModel === "openai-large") {
    return mappedModel === "openai-large";
  }

  if (deterministicModel === "qwen-coder") {
    return mappedModel === "qwen-coder";
  }

  if (deterministicModel === "gemini-search") {
    return mappedModel === "openai-large";
  }

  return true;
}

export function applyMasterChatRoutingPolicy(args: {
  readonly deterministicModel: string;
  readonly decision: MasterRoutingDecision;
  readonly options?: RouterOptions;
}): MasterRoutingResult {
  const mappedModel = MASTER_MODEL_TO_EXECUTION_MODEL[args.decision.selected_model];
  const compatible = isCompatibleChatModel(args.deterministicModel, mappedModel, args.options);

  if (isHighConfidence(args.decision) && compatible) {
    return {
      model: mappedModel,
      source: "master",
      master_model: args.decision.selected_model,
      confidence: args.decision.confidence,
      reason: args.decision.reason,
    };
  }

  if (isAdvisoryConfidence(args.decision) && mappedModel === args.deterministicModel && compatible) {
    return {
      model: mappedModel,
      source: "master",
      master_model: args.decision.selected_model,
      confidence: args.decision.confidence,
      reason: args.decision.reason,
    };
  }

  return {
    model: args.deterministicModel,
    source: "deterministic",
    master_model: args.decision.selected_model,
    confidence: args.decision.confidence,
    reason: args.decision.reason,
    fallback_reason: compatible ? "confidence_policy" : "incompatible_with_context",
  };
}

export async function selectModelForPromptWithMaster(
  args: MasterSelectionArgs,
  dependencies: MasterRouterDependencies = {},
): Promise<MasterRoutingResult> {
  const deterministicModel = selectModelForPrompt(args.query, args.classification, args.options);

  const disabledReason = getMasterRouterDisabledReason(args);
  if (disabledReason) {
    return {
      model: deterministicModel,
      source: "deterministic",
      fallback_reason: disabledReason,
    };
  }

  try {
    const decision = await requestMasterDecision({
      prompt: args.query,
      executionContext: "chat_or_file_analysis",
      hasFile: args.options?.hasFile,
      hasImage: args.options?.hasImage,
      userId: args.userId,
      signal: args.signal,
    }, dependencies);
    const routed = applyMasterChatRoutingPolicy({
      deterministicModel,
      decision,
      options: args.options,
    });
    console.log(
      `[MasterRouter] chat source=${routed.source} model=${routed.model} ` +
      `master=${decision.selected_model} confidence=${decision.confidence.toFixed(2)} ` +
      `fallback=${routed.fallback_reason ?? "none"}`,
    );
    return routed;
  } catch (error) {
    console.log(`[MasterRouter] chat fallback: ${error instanceof Error ? error.message : String(error)}`);
    return {
      model: deterministicModel,
      source: "deterministic",
      fallback_reason: "master_router_failed",
    };
  }
}

export function applyMasterImageRoutingPolicy(args: {
  readonly prompt: string;
  readonly decision: MasterRoutingDecision;
}): ImageModelPreference | null {
  const isComplex = detectPromptComplexity(args.prompt);
  const selected = args.decision.selected_model;

  if (selected !== "basic_image_generator" && selected !== "advanced_image_generator") {
    return null;
  }

  if (isHighConfidence(args.decision)) {
    return selected === "advanced_image_generator" ? "wan-image" : "zimage";
  }

  if (isAdvisoryConfidence(args.decision)) {
    if (isComplex && selected === "advanced_image_generator") return "wan-image";
    if (!isComplex && selected === "basic_image_generator") return "zimage";
  }

  return null;
}

export async function selectImageModelPreferenceWithMaster(
  args: ImageSelectionArgs,
  dependencies: MasterRouterDependencies = {},
): Promise<ImageModelPreference | undefined> {
  const disabledReason = getMasterRouterDisabledReason(args);
  if (disabledReason) {
    console.log(`[MasterRouter] image deterministic fallback=${disabledReason}`);
    return undefined;
  }

  try {
    const decision = await requestMasterDecision({
      prompt: args.prompt,
      executionContext: "image_generation",
      userId: args.userId,
      signal: args.signal,
    }, dependencies);
    const preference = applyMasterImageRoutingPolicy({ prompt: args.prompt, decision });
    console.log(
      `[MasterRouter] image preference=${preference ?? "deterministic"} ` +
      `master=${decision.selected_model} confidence=${decision.confidence.toFixed(2)}`,
    );
    return preference ?? undefined;
  } catch (error) {
    console.log(`[MasterRouter] image fallback: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
