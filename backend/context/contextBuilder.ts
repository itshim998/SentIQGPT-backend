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
import { chunkText, selectRelevantChunks } from "./fileChunker";
import { selectMemoriesForQuery } from "./memorySelector";
import { compressConversation } from "./contextCompressor";
import { semanticMemorySearch } from "../memory/semanticSearch";
import type { TextChunk } from "./fileChunker";

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
  // 1. Conversation compression — window of 6 + Groq summary of older msgs
  const allMessages = raw.recent_messages ?? [];
  const { recentMessages, summary } = await compressConversation(allMessages);

  // 2. Memories — try semantic search first, fall back to keyword overlap
  const query = raw.userMessage || recentMessages[recentMessages.length - 1]?.content || "";
  const rawMemories = (raw.memories ?? []).map((m) => ({
    type: m.type,
    summary: m.summary,
    importance: m.importance,
    embedding: m.embedding,
  }));

  let memories: readonly { type: string; summary: string }[];
  const semanticResults = await semanticMemorySearch(rawMemories, query, 3);
  if (semanticResults) {
    memories = semanticResults.map((r) => r.memory);
    console.log(`[CONTEXT] memory retrieval: semantic (${memories.length} selected)`);
  } else {
    memories = selectMemoriesForQuery(rawMemories, query, 3);
    console.log(`[CONTEXT] memory retrieval: keyword fallback (${memories.length} selected)`);
  }

  // 3. File references — chunk large files and select relevant chunks
  const rawFiles = raw.file_references ?? [];
  let fileReferences: readonly { filename: string; extractedText: string }[];

  if (rawFiles.length > 0 && query) {
    const allChunks: TextChunk[] = [];
    for (const file of rawFiles) {
      const chunks = chunkText(file.extractedText, file.filename);
      allChunks.push(...chunks);
    }
    const relevant = selectRelevantChunks(allChunks, query, 5);

    const grouped = new Map<string, string[]>();
    for (const chunk of relevant) {
      const existing = grouped.get(chunk.filename) || [];
      existing.push(chunk.text);
      grouped.set(chunk.filename, existing);
    }

    fileReferences = Array.from(grouped.entries()).map(([filename, texts]) => ({
      filename,
      extractedText: texts.join("\n\n---\n\n"),
    }));
  } else {
    fileReferences = rawFiles.map((f) => ({
      filename: f.filename,
      extractedText: f.extractedText.slice(0, 2000),
    }));
  }

  // 4. Pre-build the memory prompt block
  const memoryPromptBlock = formatMemoriesForPrompt(memories);

  // Diagnostic logging
  console.log(`[CONTEXT] memory selected: ${memories.length}`);
  console.log(`[CONTEXT] messages included: ${recentMessages.length}`);
  console.log(`[CONTEXT] summary used: ${!!summary}`);

  return {
    recentMessages,
    memories,
    fileReferences,
    memoryPromptBlock,
    conversationSummary: summary,
    hasFileContext: fileReferences.length > 0,
  };
}
