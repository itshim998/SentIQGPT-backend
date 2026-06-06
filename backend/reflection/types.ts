// SentIQ Chat v2 — Self-Reflection Types
//
// Shared interfaces for the answer critic and improver.

/**
 * Structured evaluation produced by the answer critic.
 */
export interface CriticEvaluation {
  /** Overall quality score (0.0 – 1.0). */
  readonly score: number;
  /** Individual dimension scores. */
  readonly dimensions: {
    readonly accuracy: number;
    readonly clarity: number;
    readonly completeness: number;
    readonly relevance: number;
  };
  /** Concrete issues identified in the answer. */
  readonly issues: readonly string[];
  /** Whether the answer warrants an improvement pass. */
  readonly improve: boolean;
}

/**
 * Result of the optional improvement pass.
 */
export interface ImprovementResult {
  /** The improved answer text (or original if unchanged). */
  readonly answer: string;
  /** Whether an improvement was actually applied. */
  readonly improved: boolean;
  /** Model used for the final improved answer. */
  readonly model_used?: string;
  /** Whether fallback was used for the final improved answer. */
  readonly fallback?: boolean;
  /** Brief description of what changed. */
  readonly changeNote?: string;
}
