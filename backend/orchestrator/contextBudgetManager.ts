// SentIQ Chat — Context Budget Manager
//
// Defines safe character limits for each prompt section and provides
// truncation utilities.  Prevents uncontrolled prompt growth that
// causes Node.js heap-limit crashes.

import { normalizeExecutionMode, type ExecutionMode, type ModelReasoningEffort } from "./executionProfile";

/** Standard budget for non-streaming requests (full context). */
export const CONTEXT_BUDGET = {
  /** Hard ceiling for the entire assembled prompt (chars). */
  total: 64_000,
  /** System instructions block. */
  system: 2_000,
  /** Conversation history (recent messages + summary). */
  conversation: 8_000,
  /** Retrieved memory entries. */
  memory: 6_000,
  /** Uploaded file content (combined). */
  file: 40_000,
  /** The current user message. */
  user: 2_000,
} as const;

/** Optimized budget for streaming requests (faster, leaner context).
 *  Lower limits reduce tokens for faster time-to-first-token. */
export const STREAMING_CONTEXT_BUDGET = {
  total: 32_000,
  system: 1_500,
  conversation: 4_000,  // Reduced - streaming skips compression anyway
  memory: 3_000,        // Reduced - less memory context for speed
  file: 20_000,         // Reduced - still enough for most files
  user: 2_000,          // Keep user message intact
} as const;

export type BudgetSlot = keyof typeof CONTEXT_BUDGET;
export type ContextBudgetProfile = "standard" | "streaming";
export interface ContextBudgetConfig {
  readonly total: number;
  readonly system: number;
  readonly conversation: number;
  readonly memory: number;
  readonly file: number;
  readonly user: number;
}

export interface ContextParts {
  system: string;
  conversation: string;
  memory: string;
  file: string;
  user: string;
}

/**
 * Truncate a string to `maxChars`.
 * If the text exceeds the limit it is cut at the limit and a marker is
 * appended so the model knows content was removed.
 */
export function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const marker = "\n[... truncated to fit context budget ...]";
  return text.slice(0, maxChars - marker.length) + marker;
}

export function getContextBudget(profile: ContextBudgetProfile = "standard"): ContextBudgetConfig {
  return profile === "streaming" ? STREAMING_CONTEXT_BUDGET : CONTEXT_BUDGET;
}

/**
 * Accept a bag of named context strings and enforce per-slot budgets.
 * Returns a new object where every slot is guaranteed to fit within
 * its budget.
 */
export function allocateBudget(
  parts: ContextParts,
  budget: ContextBudgetConfig = CONTEXT_BUDGET,
): ContextParts {
  return {
    system: truncateToBudget(parts.system, budget.system),
    conversation: truncateToBudget(parts.conversation, budget.conversation),
    memory: truncateToBudget(parts.memory, budget.memory),
    file: truncateToBudget(parts.file, budget.file),
    user: truncateToBudget(parts.user, budget.user),
  };
}

// Phase 1 token and completion policy. Character-slot trimming above remains
// unchanged until the context degradation work in Phase 2.
export type ContextPlanCode = "free" | "student_core" | "premium" | "pro";
export type OutputBudgetClass = "interactive" | "artifact" | "auxiliary";
export type AuxiliaryOutputKind = "title" | "routing" | "critic" | "memory" | "clarification";
export type RequestComplexity = "normal" | "heavy";
export type GroqCapacityBand = "unknown" | "healthy" | "guarded" | "constrained" | "critical";

export interface TierTokenPolicy {
  readonly normalMinTotalTokens: number;
  readonly normalMaxTotalTokens: number;
  readonly heavyMaxTotalTokens: number;
}

export const TIER_TOKEN_POLICIES: Readonly<Record<ContextPlanCode, TierTokenPolicy>> = {
  free: { normalMinTotalTokens: 2_500, normalMaxTotalTokens: 3_200, heavyMaxTotalTokens: 4_000 },
  student_core: { normalMinTotalTokens: 4_500, normalMaxTotalTokens: 6_000, heavyMaxTotalTokens: 7_500 },
  premium: { normalMinTotalTokens: 7_000, normalMaxTotalTokens: 9_500, heavyMaxTotalTokens: 12_000 },
  pro: { normalMinTotalTokens: 10_000, normalMaxTotalTokens: 16_000, heavyMaxTotalTokens: 22_000 },
};

export interface ExecutionModeOutputPolicy {
  readonly defaultOutputTokens: number;
  readonly hardOutputTokens: number;
  readonly reasoningEffort: ModelReasoningEffort;
}

/** Canonical interactive completion policy. Plans only affect total request budgets. */
export const EXECUTION_MODE_OUTPUT_POLICIES: Readonly<Record<ExecutionMode, ExecutionModeOutputPolicy>> = {
  fast: { defaultOutputTokens: 2_500, hardOutputTokens: 2_500, reasoningEffort: "low" },
  intuitive: { defaultOutputTokens: 3_500, hardOutputTokens: 3_500, reasoningEffort: "medium" },
};

export const AUXILIARY_OUTPUT_CAPS: Readonly<Record<AuxiliaryOutputKind, number>> = {
  title: 80,
  routing: 200,
  critic: 300,
  memory: 400,
  clarification: 600,
};

export const ARTIFACT_OUTPUT_POLICY = {
  defaultOutputTokens: 6_500,
  hardOutputTokens: 6_500,
} as const;

export interface GroqCapacitySnapshot {
  readonly limitTokens: number;
  readonly remainingTokens: number;
  readonly resetAfterMs?: number;
  readonly retryAfterMs?: number;
  readonly observedAtMs: number;
}

export interface InputTokenEstimate {
  readonly tokens: number;
  readonly utf8Bytes: number;
  readonly wordCount: number;
  readonly messageCount: number;
}

export interface OutputBudgetDecision {
  readonly budgetClass: OutputBudgetClass;
  readonly auxiliaryKind?: AuxiliaryOutputKind;
  readonly planCode: ContextPlanCode;
  readonly executionMode: ExecutionMode;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly selectedOutputTokens: number;
  readonly defaultOutputTokens: number;
  readonly hardOutputTokens: number;
  readonly totalTokenBudget: number;
  readonly normalMinTotalTokens: number;
  readonly capacityBand: GroqCapacityBand;
  readonly remainingRatio?: number;
  readonly allowHeavyExpansion: boolean;
  readonly forceFallback: boolean;
}

let latestGroqCapacitySnapshot: GroqCapacitySnapshot | undefined;

export function normalizeContextPlanCode(value: unknown): ContextPlanCode {
  return value === "student_core" || value === "premium" || value === "pro" ? value : "free";
}

/** Conservative tokenizer-independent estimate for text and message framing. */
export function estimateInputTokens(text: string, messageCount = 1): InputTokenEstimate {
  const utf8Bytes = Buffer.byteLength(text ?? "", "utf8");
  const wordCount = (text.match(/\S+/g) ?? []).length;
  const safeMessageCount = Math.max(1, Math.floor(messageCount));
  const contentTokens = Math.max(Math.ceil(utf8Bytes / 3), Math.ceil(wordCount * 1.5));
  return {
    tokens: Math.max(1, contentTokens + safeMessageCount * 8 + 8),
    utf8Bytes,
    wordCount,
    messageCount: safeMessageCount,
  };
}

export function recordGroqCapacitySnapshot(value: unknown): GroqCapacitySnapshot | undefined {
  if (!value || typeof value !== "object") return latestGroqCapacitySnapshot;
  const raw = value as Record<string, unknown>;
  const limitTokens = Number(raw.limit_tokens ?? raw.limitTokens);
  const remainingTokens = Number(raw.remaining_tokens ?? raw.remainingTokens);
  if (!Number.isFinite(limitTokens) || limitTokens <= 0 || !Number.isFinite(remainingTokens)) return latestGroqCapacitySnapshot;
  const resetAfterMs = Number(raw.reset_after_ms ?? raw.resetAfterMs);
  const retryAfterMs = Number(raw.retry_after_ms ?? raw.retryAfterMs);
  latestGroqCapacitySnapshot = {
    limitTokens: Math.floor(limitTokens),
    remainingTokens: Math.max(0, Math.floor(remainingTokens)),
    resetAfterMs: Number.isFinite(resetAfterMs) && resetAfterMs >= 0 ? resetAfterMs : undefined,
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : undefined,
    observedAtMs: Date.now(),
  };
  return latestGroqCapacitySnapshot;
}

export function getGroqCapacitySnapshot(maxAgeMs = 15 * 60_000): GroqCapacitySnapshot | undefined {
  if (!latestGroqCapacitySnapshot) return undefined;
  const resetAgeMs = latestGroqCapacitySnapshot.resetAfterMs === undefined
    ? maxAgeMs
    : Math.min(maxAgeMs, latestGroqCapacitySnapshot.resetAfterMs + 1_000);
  if (Date.now() - latestGroqCapacitySnapshot.observedAtMs > resetAgeMs) return undefined;
  return latestGroqCapacitySnapshot;
}

export function resolveOutputBudget(args: {
  readonly planCode: unknown;
  readonly executionMode?: unknown;
  readonly budgetClass: OutputBudgetClass;
  readonly auxiliaryKind?: AuxiliaryOutputKind;
  readonly requestedOutputTokens?: number;
  readonly estimatedInputTokens: number;
  readonly complexity?: RequestComplexity;
  readonly capacity?: GroqCapacitySnapshot;
}): OutputBudgetDecision {
  const planCode = normalizeContextPlanCode(args.planCode);
  const tier = TIER_TOKEN_POLICIES[planCode];
  const executionMode = normalizeExecutionMode(args.executionMode);
  const interactivePolicy = EXECUTION_MODE_OUTPUT_POLICIES[executionMode];
  const complexity = args.complexity ?? "normal";
  let defaultOutputTokens = interactivePolicy.defaultOutputTokens;
  let hardOutputTokens = interactivePolicy.hardOutputTokens;
  if (args.budgetClass === "artifact") {
    defaultOutputTokens = ARTIFACT_OUTPUT_POLICY.defaultOutputTokens;
    hardOutputTokens = ARTIFACT_OUTPUT_POLICY.hardOutputTokens;
  } else if (args.budgetClass === "auxiliary") {
    const cap = AUXILIARY_OUTPUT_CAPS[args.auxiliaryKind ?? "routing"];
    defaultOutputTokens = cap;
    hardOutputTokens = cap;
  }

  const requested = Number.isFinite(args.requestedOutputTokens)
    ? Math.max(1, Math.floor(args.requestedOutputTokens as number))
    : defaultOutputTokens;
  let selectedOutputTokens = Math.min(requested, hardOutputTokens);
  let capacityBand: GroqCapacityBand = "unknown";
  let remainingRatio: number | undefined;
  let allowHeavyExpansion = true;
  let forceFallback = false;

  if (args.capacity && args.capacity.limitTokens > 0 && args.budgetClass !== "artifact") {
    remainingRatio = Math.max(0, Math.min(1, args.capacity.remainingTokens / args.capacity.limitTokens));
    if (remainingRatio >= 0.5) {
      capacityBand = "healthy";
    } else if (remainingRatio >= 0.25) {
      capacityBand = "guarded";
      allowHeavyExpansion = false;
      selectedOutputTokens = Math.min(selectedOutputTokens, Math.floor(defaultOutputTokens * 0.85));
    } else if (remainingRatio >= 0.1) {
      capacityBand = "constrained";
      allowHeavyExpansion = false;
      selectedOutputTokens = Math.min(selectedOutputTokens, Math.max(256, Math.floor(defaultOutputTokens * 0.6)));
    } else {
      capacityBand = "critical";
      allowHeavyExpansion = false;
      selectedOutputTokens = Math.min(selectedOutputTokens, 256);
      forceFallback = true;
    }
    if (args.capacity.remainingTokens < Math.max(0, Math.ceil(args.estimatedInputTokens)) + 256) {
      forceFallback = true;
      capacityBand = "critical";
      allowHeavyExpansion = false;
      selectedOutputTokens = Math.min(selectedOutputTokens, 256);
    }
  }

  return {
    budgetClass: args.budgetClass,
    auxiliaryKind: args.auxiliaryKind,
    planCode,
    executionMode,
    reasoningEffort: args.budgetClass === "interactive" ? interactivePolicy.reasoningEffort : undefined,
    selectedOutputTokens: Math.max(1, selectedOutputTokens),
    defaultOutputTokens,
    hardOutputTokens,
    totalTokenBudget: capacityBand === "constrained" || capacityBand === "critical"
      ? tier.normalMinTotalTokens
      : complexity === "heavy" && allowHeavyExpansion
        ? tier.heavyMaxTotalTokens
        : tier.normalMaxTotalTokens,
    normalMinTotalTokens: tier.normalMinTotalTokens,
    capacityBand,
    remainingRatio,
    allowHeavyExpansion,
    forceFallback,
  };
}
