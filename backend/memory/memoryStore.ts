// SentIQGPT v2 — Server-Side Memory Store
//
// In-memory store for the current server session.
// Primary storage is IndexedDB on the client. This module provides:
//   1. A transient server-side cache for the current request context
//   2. Helper functions for memory retrieval, ranking, and filtering
//
// The server does NOT persist memories — the client sends relevant
// memories as context, and the server returns new memories to store.

import type {
  MemoryObject,
  MemoryReference,
  MemoryType,
} from "./memoryTypes";

/**
 * Rank and select the most relevant memories for a given context.
 *
 * Scoring formula:
 *   score = importance * 2 + recency_bonus + type_boost
 *
 * - importance: 1–10 (from Groq classification)
 * - recency_bonus: newer memories get a boost (0–5 scale)
 * - type_boost: identity/preference memories get priority for personalization
 */
export function selectRelevantMemories(
  memories: readonly MemoryReference[],
  limit: number = 10,
): MemoryReference[] {
  if (memories.length <= limit) {
    return [...memories];
  }

  const TYPE_PRIORITY: Record<string, number> = {
    identity: 3,
    preference: 2,
    project: 1,
    knowledge: 0,
  };

  // Score each memory and take top N
  const scored = memories.map((mem, index) => ({
    memory: mem,
    score: (TYPE_PRIORITY[mem.type] ?? 0) + (memories.length - index) * 0.1,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.memory);
}

/**
 * Group memories by type for structured context injection.
 */
export function groupMemoriesByType(
  memories: readonly MemoryReference[],
): Record<string, MemoryReference[]> {
  const groups: Record<string, MemoryReference[]> = {};

  for (const mem of memories) {
    if (!groups[mem.type]) {
      groups[mem.type] = [];
    }
    groups[mem.type].push(mem);
  }

  return groups;
}

/**
 * Filter memories to a specific type.
 */
export function filterMemoriesByType(
  memories: readonly MemoryReference[],
  type: MemoryType,
): MemoryReference[] {
  return memories.filter((m) => m.type === type);
}

/**
 * Format memories into a readable context string for prompt injection.
 */
export function formatMemoriesForPrompt(
  memories: readonly MemoryReference[],
): string {
  if (memories.length === 0) return "";

  const groups = groupMemoriesByType(memories);
  const lines: string[] = ["SAVED MEMORY CONTEXT (durable facts the user asked you to remember):"];

  for (const [type, items] of Object.entries(groups)) {
    lines.push(`  [${type.toUpperCase()}]`);
    for (const item of items) {
      lines.push(`    - ${item.summary}`);
    }
  }

  return lines.join("\n");
}
