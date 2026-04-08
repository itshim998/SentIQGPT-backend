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

import type { SupabaseClient } from "@supabase/supabase-js";
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
  readonly userDb?: SupabaseClient;
  readonly userId?: string;
  readonly conversationId?: string;
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
  readonly userId?: string;
}

type ContextMemory = { type: string; summary: string };

type CloudMemoryRow = {
  id?: string;
  summary: string;
  type: string;
  importance?: number;
  scope?: "global" | "chat";
  chat_id?: string | null;
};

async function fetchCloudMemories(
  userDb: SupabaseClient,
  userId: string,
  conversationId?: string,
): Promise<readonly ContextMemory[]> {
  const { data: cloudMemories, error } = await userDb
    .from("memories")
    .select("id, summary, type, importance, scope, chat_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    throw error;
  }

  return ((cloudMemories ?? []) as CloudMemoryRow[])
    .filter((memory) => {
      const scope = memory.scope === "chat" ? "chat" : "global";
      if (scope === "global") return true;
      return !!conversationId && memory.chat_id === conversationId;
    })
    .map((memory) => ({
      type: memory.type,
      summary: memory.summary,
    }));
}

function mergeMemories(
  localMemories: readonly ContextMemory[],
  cloudMemories: readonly ContextMemory[],
): readonly ContextMemory[] {
  const merged: ContextMemory[] = [];
  const seenSummaries = new Set<string>();

  for (const memory of [...localMemories, ...cloudMemories]) {
    const summary = memory.summary;
    if (!summary || seenSummaries.has(summary)) continue;
    seenSummaries.add(summary);
    merged.push(memory);
    if (merged.length >= 10) break;
  }

  return merged;
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
 *
 * OPTIMIZATION: Cloud memory fetch now runs in parallel with compression
 * and semantic search to minimize total latency.
 */
export async function buildContext(
  raw: RawMessageContext,
  userDb?: SupabaseClient,
  userId?: string,
): Promise<BuiltContext> {
  const ctxStart = Date.now();

  // Derive the query early so all pipelines can use it.
  const allMessages = raw.recent_messages ?? [];
  const query = raw.userMessage || allMessages[allMessages.length - 1]?.content || "";

  const rawMemories = (raw.memories ?? []).map((m) => ({
    type: m.type,
    summary: m.summary,
    importance: m.importance,
    embedding: m.embedding,
  }));

  const normalizedUserId = userId?.trim();

  // ── PARALLEL: conversation compression + semantic memory search + cloud memory fetch ──
  // All three operations are independent and can run concurrently.
  const cloudMemoryPromise = (userDb && normalizedUserId)
    ? fetchCloudMemories(userDb, normalizedUserId, raw.conversationId)
    : Promise.resolve([] as readonly ContextMemory[]);

  const [compressionResult, semanticResults, cloudMemories] = await Promise.all([
    compressConversation(allMessages, userId),
    semanticMemorySearch(rawMemories, query, 3),
    cloudMemoryPromise,
  ]);

  const { recentMessages, summary } = compressionResult;

  let memories: readonly ContextMemory[];
  if (semanticResults) {
    memories = semanticResults.map((r) => r.memory);
    console.log(`[CONTEXT] memory retrieval: semantic (${memories.length} selected)`);
  } else {
    memories = selectMemoriesForQuery(rawMemories, query, 3);
    console.log(`[CONTEXT] memory retrieval: keyword fallback (${memories.length} selected)`);
  }

  // Merge cloud memories (already fetched in parallel)
  if (cloudMemories.length > 0) {
    memories = mergeMemories(memories, cloudMemories);
  }

  // 3. File references — pass through full content for prompt-level handling
  //    (PromptBuilders.ts applies safe truncation at 40k per file)
  const rawFiles = raw.file_references ?? [];
  const fileReferences: readonly { filename: string; extractedText: string; imageBase64?: string; mimeType?: string }[] =
    rawFiles.map((f) => ({
      filename: f.filename,
      extractedText: f.extractedText,
      imageBase64: f.imageBase64,
      mimeType: f.mimeType,
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
    userId: normalizedUserId,
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
 *  5. OPTIMIZATION: Cloud memory fetch runs in parallel with setup
 *
 * Use this for /api/chat/stream where time-to-first-token is critical.
 * The tradeoff is slightly less context for very long conversations.
 */
export async function buildContextFast(
  raw: RawMessageContext,
  userDb?: SupabaseClient,
  userId?: string,
): Promise<BuiltContext> {
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

  const normalizedUserId = userId?.trim();

  // Start cloud memory fetch early (async)
  const cloudMemoryPromise = (userDb && normalizedUserId)
    ? fetchCloudMemories(userDb, normalizedUserId, raw.conversationId)
    : Promise.resolve([] as readonly ContextMemory[]);

  // Use fast keyword-based memory selection (synchronous)
  let memories: readonly ContextMemory[] = selectMemoriesForQuery(rawMemories, query, 3);

  // Await cloud memories (started earlier, likely already resolved)
  const cloudMemories = await cloudMemoryPromise;
  if (cloudMemories.length > 0) {
    memories = mergeMemories(memories, cloudMemories);
  }

  // File references - just text extracted content
  const fileReferences = (raw.file_references ?? []).map((f) => ({
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
    userId: normalizedUserId,
  };
}
