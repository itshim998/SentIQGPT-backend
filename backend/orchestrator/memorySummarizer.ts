// SentIQ Chat v2 — Memory Summarizer (Orchestrator Layer)
//
// Thin orchestrator wrapper around MemoryProcessor.summarizeMemory().
// Translates the v1 result into canonical MemorySummaryResult types.

import { summarizeMemory, compressMemories } from "../ai/MemoryProcessor";
import type {
  MemorySummaryResult,
  MemoryCompressionResult,
} from "../memory/memoryTypes";

export interface SummarizeInput {
  readonly message: string;
  readonly memoryType: string;
  readonly existingMemories?: readonly { summary: string }[];
}

export interface CompressInput {
  readonly memories: readonly {
    summary: string;
    importance: number;
    timestamp: string;
  }[];
}

/**
 * Summarize a user message into a memory entry.
 *
 * Delegates to the Groq-powered summarizer in MemoryProcessor and
 * normalizes the result into the canonical MemorySummaryResult shape.
 */
export async function summarizeForMemory(
  input: SummarizeInput,
): Promise<MemorySummaryResult> {
  const raw = await summarizeMemory({
    message: input.message,
    memoryType: input.memoryType,
    existingMemories: input.existingMemories,
  });

  return {
    summary: raw.summary,
    importance: raw.importance,
  };
}

/**
 * Compress multiple old memories into one condensed entry.
 *
 * Delegates to the Groq-powered compressor in MemoryProcessor.
 */
export async function compressForMemory(
  input: CompressInput,
): Promise<MemoryCompressionResult> {
  const raw = await compressMemories({
    memories: input.memories,
  });

  return {
    compressed_summary: raw.compressed_summary,
    importance: raw.importance,
  };
}
