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
export type GenerationProviderCapability = "legacy_text" | "nemotron_reasoning";

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface InputContextPolicy {
  readonly constrainedCeilingTokens: number;
  readonly ordinaryCeilingTokens: number;
  readonly complexCeilingTokens: number;
}

/**
 * Canonical composed-input policy. Paid-plan differentiation is intentionally
 * unchanged in Pass 3; only Free Fast and Free Intuitive are mode-distinct.
 */
export const PLAN_MODE_INPUT_CONTEXT_POLICIES: Readonly<
  Record<ContextPlanCode, Readonly<Record<ExecutionMode, InputContextPolicy>>>
> = {
  free: {
    fast: {
      constrainedCeilingTokens: 2_500,
      ordinaryCeilingTokens: positiveEnv("SENTIQ_FREE_FAST_ORDINARY_CONTEXT_TOKENS", 3_200),
      complexCeilingTokens: positiveEnv("SENTIQ_FREE_FAST_COMPLEX_CONTEXT_TOKENS", 4_000),
    },
    intuitive: {
      constrainedCeilingTokens: 2_500,
      ordinaryCeilingTokens: positiveEnv("SENTIQ_FREE_INTUITIVE_ORDINARY_CONTEXT_TOKENS", 6_000),
      complexCeilingTokens: positiveEnv("SENTIQ_FREE_INTUITIVE_COMPLEX_CONTEXT_TOKENS", 8_000),
    },
  },
  student_core: {
    fast: { constrainedCeilingTokens: 4_500, ordinaryCeilingTokens: 6_000, complexCeilingTokens: 7_500 },
    intuitive: { constrainedCeilingTokens: 4_500, ordinaryCeilingTokens: 6_000, complexCeilingTokens: 7_500 },
  },
  premium: {
    fast: { constrainedCeilingTokens: 7_000, ordinaryCeilingTokens: 9_500, complexCeilingTokens: 12_000 },
    intuitive: { constrainedCeilingTokens: 7_000, ordinaryCeilingTokens: 9_500, complexCeilingTokens: 12_000 },
  },
  pro: {
    fast: { constrainedCeilingTokens: 10_000, ordinaryCeilingTokens: 16_000, complexCeilingTokens: 22_000 },
    intuitive: { constrainedCeilingTokens: 10_000, ordinaryCeilingTokens: 16_000, complexCeilingTokens: 22_000 },
  },
};

export interface ExecutionModeGenerationPolicy {
  readonly defaultGenerationTokens: number;
  readonly generationCeilingTokens: number;
  readonly reasoningEffort: ModelReasoningEffort;
}

/** Canonical legacy interactive completion policy for non-Nemotron calls. */
export const EXECUTION_MODE_GENERATION_POLICIES: Readonly<Record<ExecutionMode, ExecutionModeGenerationPolicy>> = {
  fast: { defaultGenerationTokens: 2_500, generationCeilingTokens: 2_500, reasoningEffort: "low" },
  intuitive: { defaultGenerationTokens: 3_500, generationCeilingTokens: 3_500, reasoningEffort: "medium" },
};

export interface IntuitiveGenerationPolicy {
  readonly generationCeilingTokens: number;
  readonly maximumReasoningTokens: number;
  readonly protectedVisibleAnswerTokens: number;
  readonly timeoutMs: number;
}

export const INTUITIVE_GENERATION_POLICIES: Readonly<Record<RequestComplexity, IntuitiveGenerationPolicy>> = {
  normal: {
    generationCeilingTokens: positiveEnv("SENTIQ_INTUITIVE_ORDINARY_MAX_GENERATED_TOKENS", 6_000),
    maximumReasoningTokens: positiveEnv("SENTIQ_INTUITIVE_ORDINARY_REASONING_BUDGET", 2_000),
    protectedVisibleAnswerTokens: positiveEnv("SENTIQ_INTUITIVE_ORDINARY_MIN_FINAL_ANSWER_TOKENS", 1_500),
    timeoutMs: positiveEnv("SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS", 120_000),
  },
  heavy: {
    generationCeilingTokens: positiveEnv("SENTIQ_INTUITIVE_COMPLEX_MAX_GENERATED_TOKENS", 8_000),
    maximumReasoningTokens: positiveEnv("SENTIQ_INTUITIVE_COMPLEX_REASONING_BUDGET", 3_500),
    protectedVisibleAnswerTokens: positiveEnv("SENTIQ_INTUITIVE_COMPLEX_MIN_FINAL_ANSWER_TOKENS", 2_000),
    timeoutMs: positiveEnv("SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS", 120_000),
  },
};

/** Provider hard safety ceiling, not a plan or mode product policy. */
export const NEMOTRON_PROVIDER_GENERATION_SAFETY_CEILING_TOKENS = positiveEnv(
  "SENTIQ_NVIDIA_MAX_GENERATED_TOKENS",
  8_000,
);

export const AUXILIARY_OUTPUT_CAPS: Readonly<Record<AuxiliaryOutputKind, number>> = {
  title: 80,
  routing: 200,
  memory: 400,
};

export const ARTIFACT_GENERATION_POLICY = {
  defaultGenerationTokens: 6_500,
  generationCeilingTokens: 6_500,
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

export interface GenerationBudgetDecision {
  readonly budgetClass: OutputBudgetClass;
  readonly auxiliaryKind?: AuxiliaryOutputKind;
  readonly planCode: ContextPlanCode;
  readonly executionMode: ExecutionMode;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly selectedGenerationTokens: number;
  readonly defaultGenerationTokens: number;
  readonly generationCeilingTokens: number;
  readonly inputContextCeilingTokens: number;
  readonly constrainedInputContextCeilingTokens: number;
  readonly capacityBand: GroqCapacityBand;
  readonly remainingRatio?: number;
  readonly allowHeavyExpansion: boolean;
  readonly forceFallback: boolean;
  readonly providerCapability: GenerationProviderCapability;
  readonly providerMaximumGeneratedTokens?: number;
  readonly reasoningBudgetTokens: number;
  readonly protectedVisibleAnswerTokens: number;
  readonly timeoutMs?: number;
}

export class GenerationBudgetError extends Error {
  readonly code: string;

  constructor(
    message = "The current request reservation cannot support a meaningful answer.",
    code = "generation_budget_insufficient",
  ) {
    super(message);
    this.name = "GenerationBudgetError";
    this.code = code;
  }
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

export function resolveInputContextCeiling(args: {
  readonly planCode: unknown;
  readonly executionMode?: unknown;
  readonly complexity?: RequestComplexity;
  readonly capacityBand?: GroqCapacityBand;
}): number {
  const planCode = normalizeContextPlanCode(args.planCode);
  const executionMode = normalizeExecutionMode(args.executionMode);
  const policy = PLAN_MODE_INPUT_CONTEXT_POLICIES[planCode][executionMode];
  if (args.capacityBand === "constrained" || args.capacityBand === "critical") {
    return policy.constrainedCeilingTokens;
  }
  return args.complexity === "heavy"
    ? policy.complexCeilingTokens
    : policy.ordinaryCeilingTokens;
}

export function resolveGenerationBudget(args: {
  readonly planCode: unknown;
  readonly executionMode?: unknown;
  readonly budgetClass: OutputBudgetClass;
  readonly auxiliaryKind?: AuxiliaryOutputKind;
  readonly requestedOutputTokens?: number;
  readonly estimatedInputTokens: number;
  readonly complexity?: RequestComplexity;
  readonly capacity?: GroqCapacitySnapshot;
  readonly remainingReservationTokens?: number;
  readonly providerCapability?: GenerationProviderCapability;
  readonly providerMaximumGeneratedTokens?: number;
  readonly reservationFeature?: "premium_text" | "lite_text";
}): GenerationBudgetDecision {
  const planCode = normalizeContextPlanCode(args.planCode);
  const executionMode = normalizeExecutionMode(args.executionMode);
  const inputContextPolicy = PLAN_MODE_INPUT_CONTEXT_POLICIES[planCode][executionMode];
  const interactivePolicy = EXECUTION_MODE_GENERATION_POLICIES[executionMode];
  const complexity = args.complexity ?? "normal";
  const providerCapability = args.providerCapability ?? "legacy_text";
  const intuitiveGenerationPolicy = INTUITIVE_GENERATION_POLICIES[complexity];
  const usesReasoningGenerationBudget = args.budgetClass === "interactive"
    && executionMode === "intuitive"
    && providerCapability === "nemotron_reasoning";
  let defaultGenerationTokens = interactivePolicy.defaultGenerationTokens;
  let generationCeilingTokens = interactivePolicy.generationCeilingTokens;
  if (usesReasoningGenerationBudget) {
    defaultGenerationTokens = intuitiveGenerationPolicy.generationCeilingTokens;
    generationCeilingTokens = intuitiveGenerationPolicy.generationCeilingTokens;
  } else if (args.budgetClass === "artifact") {
    defaultGenerationTokens = ARTIFACT_GENERATION_POLICY.defaultGenerationTokens;
    generationCeilingTokens = ARTIFACT_GENERATION_POLICY.generationCeilingTokens;
  } else if (args.budgetClass === "auxiliary") {
    const cap = AUXILIARY_OUTPUT_CAPS[args.auxiliaryKind ?? "routing"];
    defaultGenerationTokens = cap;
    generationCeilingTokens = cap;
  }

  const requested = Number.isFinite(args.requestedOutputTokens)
    ? Math.max(1, Math.floor(args.requestedOutputTokens as number))
    : defaultGenerationTokens;
  let selectedGenerationTokens = Math.min(requested, generationCeilingTokens);
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
      selectedGenerationTokens = Math.min(selectedGenerationTokens, Math.floor(defaultGenerationTokens * 0.85));
    } else if (remainingRatio >= 0.1) {
      capacityBand = "constrained";
      allowHeavyExpansion = false;
      selectedGenerationTokens = Math.min(selectedGenerationTokens, Math.max(256, Math.floor(defaultGenerationTokens * 0.6)));
    } else {
      capacityBand = "critical";
      allowHeavyExpansion = false;
      selectedGenerationTokens = Math.min(selectedGenerationTokens, 256);
      forceFallback = true;
    }
    if (args.capacity.remainingTokens < Math.max(0, Math.ceil(args.estimatedInputTokens)) + 256) {
      forceFallback = true;
      capacityBand = "critical";
      allowHeavyExpansion = false;
      selectedGenerationTokens = Math.min(selectedGenerationTokens, 256);
    }
  }

  const providerMaximumGeneratedTokens = Number.isFinite(args.providerMaximumGeneratedTokens)
    ? Math.max(1, Math.floor(args.providerMaximumGeneratedTokens as number))
    : providerCapability === "nemotron_reasoning"
      ? NEMOTRON_PROVIDER_GENERATION_SAFETY_CEILING_TOKENS
      : undefined;
  if (providerMaximumGeneratedTokens !== undefined) {
    selectedGenerationTokens = Math.min(
      selectedGenerationTokens,
      providerMaximumGeneratedTokens,
    );
  }

  if (Number.isFinite(args.remainingReservationTokens)) {
    const affordableGeneratedTokens = Math.floor(Number(args.remainingReservationTokens))
      - Math.max(0, Math.ceil(args.estimatedInputTokens));
    const minimumAnswerTokens = usesReasoningGenerationBudget
      ? intuitiveGenerationPolicy.protectedVisibleAnswerTokens
      : 32;
    if (affordableGeneratedTokens < minimumAnswerTokens) {
      if (!usesReasoningGenerationBudget) {
        const allowanceLabel = args.reservationFeature === "lite_text" ? "Lite" : "Standard";
        throw new GenerationBudgetError(
          `The ${allowanceLabel} token reservation cannot support another model call.`,
          "token_reservation_exhausted",
        );
      }
      throw new GenerationBudgetError();
    }
    selectedGenerationTokens = Math.min(selectedGenerationTokens, affordableGeneratedTokens);
  }

  const protectedVisibleAnswerTokens = usesReasoningGenerationBudget
    ? intuitiveGenerationPolicy.protectedVisibleAnswerTokens
    : 0;
  if (usesReasoningGenerationBudget && selectedGenerationTokens < protectedVisibleAnswerTokens) {
    throw new GenerationBudgetError();
  }
  const reasoningBudgetTokens = usesReasoningGenerationBudget
    ? Math.max(
        0,
        Math.min(
          intuitiveGenerationPolicy.maximumReasoningTokens,
          selectedGenerationTokens - protectedVisibleAnswerTokens,
        ),
      )
    : 0;

  return {
    budgetClass: args.budgetClass,
    auxiliaryKind: args.auxiliaryKind,
    planCode,
    executionMode,
    reasoningEffort: args.budgetClass === "interactive" ? interactivePolicy.reasoningEffort : undefined,
    selectedGenerationTokens: Math.max(1, selectedGenerationTokens),
    defaultGenerationTokens,
    generationCeilingTokens,
    inputContextCeilingTokens: resolveInputContextCeiling({
      planCode,
      executionMode,
      complexity: complexity === "heavy" && allowHeavyExpansion ? "heavy" : "normal",
      capacityBand,
    }),
    constrainedInputContextCeilingTokens: inputContextPolicy.constrainedCeilingTokens,
    capacityBand,
    remainingRatio,
    allowHeavyExpansion,
    forceFallback,
    providerCapability,
    providerMaximumGeneratedTokens,
    reasoningBudgetTokens,
    protectedVisibleAnswerTokens,
    timeoutMs: usesReasoningGenerationBudget ? intuitiveGenerationPolicy.timeoutMs : undefined,
  };
}
