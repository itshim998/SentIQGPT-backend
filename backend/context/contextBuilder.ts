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

import type { MemoryReference } from "../memory/memoryTypes";
import { formatMemoriesForPrompt } from "../memory/memoryStore";
import { selectMemoriesForQuery } from "./memorySelector";
import { compressConversation } from "./contextCompressor";
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
