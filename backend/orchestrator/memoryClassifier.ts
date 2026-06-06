// SentIQ Chat v2 — Memory Classifier (Orchestrator Layer)
//
// Thin orchestrator wrapper around MemoryProcessor.classifyMemory().
// Translates the v1 result into canonical MemoryClassificationResult types.

import { classifyMemory } from "../ai/MemoryProcessor";
import type { MemoryClassificationResult } from "../memory/memoryTypes";
import { isValidMemoryType } from "../memory/memoryTypes";

export interface ClassifyInput {
  readonly message: string;
  readonly recentMessages?: readonly { role: string; content: string }[];
}

/**
 * Classify a user message for memory storage worthiness.
 *
 * Delegates to the Groq-powered classifier in MemoryProcessor and
 * normalizes the result into the canonical MemoryClassificationResult shape.
 */
export async function classifyForMemory(
  input: ClassifyInput,
): Promise<MemoryClassificationResult> {
  const raw = await classifyMemory({
    message: input.message,
    recentMessages: input.recentMessages,
  });

  return {
    should_store: raw.should_store,
    type: isValidMemoryType(raw.type) ? raw.type : null,
    reason: raw.reason,
  };
}
