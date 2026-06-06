// SentIQ Chat v2 — Memory Type Definitions
//
// Canonical type definitions for the memory system.
// Used across all memory pipeline modules.

/**
 * Supported memory categories.
 * - identity: facts about the user (name, age, location, occupation)
 * - preference: likes, dislikes, preferred styles/behaviors
 * - project: ongoing work, goals, tasks
 * - knowledge: facts, concepts, or technical info shared by user
 */
export type MemoryType = "identity" | "preference" | "project" | "knowledge";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "identity",
  "preference",
  "project",
  "knowledge",
] as const;

/**
 * A stored memory object with full metadata.
 */
export interface MemoryObject {
  readonly id: string;
  readonly type: MemoryType;
  readonly summary: string;
  readonly importance: number; // 1–10
  readonly timestamp: string; // ISO 8601
  readonly embedding?: readonly number[];
  readonly scope?: "global" | "chat";
  readonly chat_id?: string | null;
  readonly persisted?: boolean;
  readonly source_conversation_id?: string | null;
  readonly failure_reason?: string;
  readonly source_message_id?: string;
}

/**
 * Lightweight memory reference sent by the client as context.
 */
export interface MemoryReference {
  readonly type: string;
  readonly summary: string;
  readonly importance?: number;
  readonly embedding?: readonly number[];
  readonly scope?: "global" | "chat";
  readonly chat_id?: string | null;
  readonly persisted?: boolean;
  readonly source_conversation_id?: string | null;
  readonly failure_reason?: string;
}

/**
 * Result of memory classification (Groq).
 */
export interface MemoryClassificationResult {
  readonly should_store: boolean;
  readonly type: MemoryType | null;
  readonly reason: string;
}

/**
 * Result of memory summarization (Groq).
 */
export interface MemorySummaryResult {
  readonly summary: string;
  readonly importance: number;
}

/**
 * Result of memory compression (Groq).
 */
export interface MemoryCompressionResult {
  readonly compressed_summary: string;
  readonly importance: number;
}

/**
 * Full result of the classify → summarize pipeline.
 */
export interface MemoryPipelineResult {
  readonly stored: boolean;
  readonly failure_reason?: string;
  readonly memory?: {
    readonly type: MemoryType;
    readonly summary: string;
    readonly importance: number;
    readonly embedding?: readonly number[];
    readonly scope?: "global" | "chat";
    readonly chat_id?: string | null;
    readonly persisted?: boolean;
    readonly source_conversation_id?: string | null;
    readonly failure_reason?: string;
  };
}

/**
 * Validate that a string is one of the known memory types.
 */
export function isValidMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && MEMORY_TYPES.includes(value as MemoryType);
}
