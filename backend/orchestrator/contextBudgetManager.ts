// SentIQ Chat — Context Budget Manager
//
// Defines safe character limits for each prompt section and provides
// truncation utilities.  Prevents uncontrolled prompt growth that
// causes Node.js heap-limit crashes.

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
