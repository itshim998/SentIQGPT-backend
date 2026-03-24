// SentIQGPT v2 — Context Builder (with Compression + Semantic Retrieval)
//
// Assembles the context window before sending to the reasoning model.
// Combines: recent messages + relevant memories + smart file chunks
// into a structured context object for ChatHandler.
//
// Compression pipeline:
//   1. Conversation window  — last 6 messages kept verbatim
//   2. Older-message summary — Groq-generated 1-2 sentence summary
//   3. Memory retrieval      — semantic (cosine) when embeddings exist,
//                               keyword fallback otherwise
//   4. File chunking — most relevant chunks for the query
//
// PERFORMANCE OPTIMIZATION:
//   - buildContextFast() skips compression for streaming (latency-critical)
//   - buildContext() uses full compression for non-streaming requests

import type { MemoryReference } from "../memory/memoryTypes";
import { formatMemoriesForPrompt } from "../memory/memoryStore";
import { selectMemoriesForQuery } from "./memorySelector";
import { compressConversation, CONVERSATION_WINDOW } from "./contextCompressor";
import { semanticMemorySearch } from "../memory/semanticSearch";

export interface RawMessageContext {
  readonly recent_messages?: readonly { role: string; content: string }[];
  readonly memories?: readonly { type: string; summary: string; importance?: number; embedding?: readonly number[] }[];
  readonly file_references?: readonly {
    filename: string;
    extractedText: string;
  }[];
  readonly userMessage?: string;
}

export interface BuiltContext {
  readonly recentMessages: readonly { role: string; content: string }[];
  readonly memories: readonly { type: string; summary: string }[];
  readonly fileReferences: readonly {
    filename: string;
    extractedText: string;
  }[];
  readonly memoryPromptBlock: string;
  readonly conversationSummary?: string;
  readonly hasFileContext: boolean;
}

/**
 * Build the full compressed context for the reasoning model.
 *
 * Steps:
 *  1. Compress conversation (window + optional summary via Groq)
 *  2. Select memories — semantic search (cosine) if embeddings exist,
 *     keyword fallback otherwise
 *  3. Chunk files and select relevant chunks for the query
 *  4. Pre-build the memory prompt block for injection
 */
export async function buildContext(raw: RawMessageContext): Promise<BuiltContext> {
  const ctxStart = Date.now();

  // Derive the query early so both pipelines can use it.
  const allMessages = raw.recent_messages ?? [];
  const query = raw.userMessage || allMessages[allMessages.length - 1]?.content || "";

  const rawMemories = (raw.memories ?? []).map((m) => ({
    type: m.type,
    summary: m.summary,
    importance: m.importance,
    embedding: m.embedding,
  }));

  // ── PARALLEL: conversation compression + semantic memory search ──
  // These are the two slowest sub-operations and are independent.
  const [compressionResult, semanticResults] = await Promise.all([
    compressConversation(allMessages),
    semanticMemorySearch(rawMemories, query, 3),
  ]);

  const { recentMessages, summary } = compressionResult;

  let memories: readonly { type: string; summary: string }[];
  if (semanticResults) {
    memories = semanticResults.map((r) => r.memory);
    console.log(`[CONTEXT] memory retrieval: semantic (${memories.length} selected)`);
  } else {
    memories = selectMemoriesForQuery(rawMemories, query, 3);
    console.log(`[CONTEXT] memory retrieval: keyword fallback (${memories.length} selected)`);
  }

  // 3. File references — pass through full content for prompt-level handling
  //    (PromptBuilders.ts applies safe truncation at 40k per file)
  const rawFiles = raw.file_references ?? [];
  const fileReferences: readonly { filename: string; extractedText: string }[] =
    rawFiles.map((f) => ({
      filename: f.filename,
      extractedText: f.extractedText,
    }));
  if (fileReferences.length > 0) {
    const totalChars = fileReferences.reduce((s, f) => s + f.extractedText.length, 0);
    console.log(`[CONTEXT] file pass-through: ${fileReferences.length} file(s), ${totalChars} total chars`);
  }

  // 4. Pre-build the memory prompt block
  const memoryPromptBlock = formatMemoriesForPrompt(memories);

  // Diagnostic logging
  console.log(`[CONTEXT] memory selected: ${memories.length}`);
  console.log(`[CONTEXT] messages included: ${recentMessages.length}`);
  console.log(`[CONTEXT] summary used: ${!!summary}`);
  console.log(`[CONTEXT] buildContext completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages,
    memories,
    fileReferences,
    memoryPromptBlock,
    conversationSummary: summary,
    hasFileContext: fileReferences.length > 0,
  };
}

/**
 * FAST context builder for streaming - optimized for minimum latency.
 *
 * Key differences from buildContext():
 *  1. SKIPS conversation compression (no Groq LLM call)
 *  2. Uses only the recent message window directly
 *  3. Runs memory selection synchronously (keyword fallback) for speed
 *  4. Still processes files if present
 *
 * Use this for /api/chat/stream where time-to-first-token is critical.
 * The tradeoff is slightly less context for very long conversations.
 */
export async function buildContextFast(raw: RawMessageContext): Promise<BuiltContext> {
  const ctxStart = Date.now();

  // Get recent messages directly - no compression, no LLM call
  const allMessages = raw.recent_messages ?? [];
  const recentMessages = allMessages.slice(-CONVERSATION_WINDOW);
  const query = raw.userMessage || recentMessages[recentMessages.length - 1]?.content || "";

  const rawMemories = (raw.memories ?? []).map((m) => ({
    type: m.type,
    summary: m.summary,
    importance: m.importance,
    embedding: m.embedding,
  }));

  // Use fast keyword-based memory selection (no async operations)
  // This avoids waiting for semantic search which can add latency
  const memories = selectMemoriesForQuery(rawMemories, query, 3);

  // File references - pass through unchanged
  const rawFiles = raw.file_references ?? [];
  const fileReferences: readonly { filename: string; extractedText: string }[] =
    rawFiles.map((f) => ({
      filename: f.filename,
      extractedText: f.extractedText,
    }));

  // Pre-build the memory prompt block
  const memoryPromptBlock = formatMemoriesForPrompt(memories);

  console.log(`[CONTEXT-FAST] memory selected: ${memories.length} (keyword)`);
  console.log(`[CONTEXT-FAST] messages included: ${recentMessages.length}`);
  console.log(`[CONTEXT-FAST] buildContextFast completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages,
    memories,
    fileReferences,
    memoryPromptBlock,
    conversationSummary: undefined, // No compression = no summary
    hasFileContext: fileReferences.length > 0,
  };
}
