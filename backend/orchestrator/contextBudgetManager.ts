// SentIQ Chat — Context Budget Manager
//
// Defines conservative token estimates, input-context budgets, completion
// policies, and character-only emergency guards used by the composer.

import { normalizeExecutionMode, type ExecutionMode, type ModelReasoningEffort } from "./executionProfile";

export type ContextBudgetProfile = "standard" | "streaming";
// Canonical request, input-context, and completion policy registry.
export type ContextPlanCode = "free" | "student_core" | "premium" | "pro";
export type OutputBudgetClass = "interactive" | "artifact" | "auxiliary";
export type AuxiliaryOutputKind = "title" | "routing" | "memory";
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
  memory: 400,
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

export type TokenTrimMode = "head" | "head_tail";

const TOKEN_TRIM_MARKER = "\n[... context trimmed to fit request budget ...]\n";

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

/** Conservative content-only estimate for allocating individual prompt sections. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const wordCount = (text.match(/\S+/g) ?? []).length;
  return Math.max(1, Math.ceil(Math.max(utf8Bytes / 3, wordCount * 1.5)));
}

/**
 * Trim text using the same tokenizer-independent estimate used by the allocator.
 * Character slicing remains only the mechanism for finding a token-safe boundary.
 */
export function trimTextToTokenBudget(
  text: string,
  maxTokens: number,
  mode: TokenTrimMode = "head",
): string {
  const safeMaxTokens = Math.max(0, Math.floor(maxTokens));
  if (!text || safeMaxTokens <= 0) return "";
  if (estimateTextTokens(text) <= safeMaxTokens) return text;

  const markerTokens = estimateTextTokens(TOKEN_TRIM_MARKER);
  if (safeMaxTokens <= markerTokens + 2) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTextTokens(text.slice(0, mid)) <= safeMaxTokens) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low);
  }

  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const retainedChars = Math.floor((low + high) / 2);
    const candidate = mode === "head_tail"
      ? text.slice(0, Math.ceil(retainedChars / 2)) +
        TOKEN_TRIM_MARKER +
        text.slice(text.length - Math.floor(retainedChars / 2))
      : text.slice(0, retainedChars).trimEnd() + TOKEN_TRIM_MARKER;
    if (estimateTextTokens(candidate) <= safeMaxTokens) {
      best = candidate;
      low = retainedChars + 1;
    } else {
      high = retainedChars - 1;
    }
  }
  return best || text.slice(0, Math.max(1, Math.floor(text.length * 0.1)));
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
