// SentIQGPT — Context Budget Manager
//
// Defines safe character limits for each prompt section and provides
// truncation utilities.  Prevents uncontrolled prompt growth that
// causes Node.js heap-limit crashes.

export const CONTEXT_BUDGET = {
  /** Hard ceiling for the entire assembled prompt (chars). */
  total: 64_000,
  /** System instructions block. */
  system: 2_000,
  /** Conversation history (recent messages + summary). */
  conversation: 8_000,
  /** Retrieved memory entries. */
  memory: 6_000,
  /** Web-search context block. */
  search: 6_000,
  /** Uploaded file content (combined). */
  file: 40_000,
  /** The current user message. */
  user: 2_000,
} as const;

export type BudgetSlot = keyof typeof CONTEXT_BUDGET;

export interface ContextParts {
  system: string;
  conversation: string;
  memory: string;
  search: string;
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

/**
 * Accept a bag of named context strings and enforce per-slot budgets.
 * Returns a new object where every slot is guaranteed to fit within
 * its budget.
 */
export function allocateBudget(parts: ContextParts): ContextParts {
  return {
    system: truncateToBudget(parts.system, CONTEXT_BUDGET.system),
    conversation: truncateToBudget(parts.conversation, CONTEXT_BUDGET.conversation),
    memory: truncateToBudget(parts.memory, CONTEXT_BUDGET.memory),
    search: truncateToBudget(parts.search, CONTEXT_BUDGET.search),
    file: truncateToBudget(parts.file, CONTEXT_BUDGET.file),
    user: truncateToBudget(parts.user, CONTEXT_BUDGET.user),
  };
}
