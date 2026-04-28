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
import { formatMemoriesForPrompt } from "../memory/memoryStore";
import { selectMemoriesForQuery } from "./memorySelector";
import { compressConversation, CONVERSATION_WINDOW } from "./contextCompressor";
import { semanticMemorySearch } from "../memory/semanticSearch";
import type { WebSearchMode } from "../tools/webSearch/webSearchMode";
import { getPriorConversationUserMessages } from "../services/conversationService";
import { collapseAdjacentDuplicateMessages } from "./messageDeduper";

export interface RawMessageContext {
  readonly recent_messages?: readonly { role: string; content: string }[];
  readonly memories?: readonly { type: string; summary: string; importance?: number; embedding?: readonly number[] }[];
  readonly file_references?: readonly {
    filename: string;
    extractedText: string;
  }[];
  readonly trustedProfile?: {
    displayName: string;
  };
  readonly web_search_mode?: WebSearchMode;
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
  readonly webSearchMode?: WebSearchMode;
  readonly userId?: string;
  readonly trustedProfile?: {
    displayName: string;
  };
  readonly priorConversationEvidence: readonly {
    conversationId: string;
    content: string;
    createdAt: string;
  }[];
  readonly isExplicitRecallQuery: boolean;
}

type ContextMemory = { type: string; summary: string };
type ContextRecallEvidence = {
  conversationId: string;
  content: string;
  createdAt: string;
};

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

const RECALL_QUERY_PATTERNS: readonly RegExp[] = [
  /\bdo\s+you\s+remember\b/i,
  /\bdid\s+i\s+(?:ask|mention|say|tell\s+you)\b/i,
  /\b(?:earlier|before|previous\s+chat|last\s+time\s+i\s+asked)\b/i,
  /\b(?:from|in)\s+(?:another|a\s+different)\s+chat\b/i,
];

const RECALL_PREFIX_PATTERNS: readonly RegExp[] = [
  /^\s*do\s+you\s+remember\s+(?:me\s+)?(?:asking|mentioning|saying|telling\s+you)\s+(?:about\s+)?/i,
  /^\s*did\s+i\s+(?:ask|mention|say|tell\s+you)\s+(?:about\s+)?/i,
  /^\s*what\s+did\s+i\s+(?:ask|mention|say)\s+(?:about\s+)?/i,
  /\b(?:earlier|before|in\s+another\s+chat|in\s+a\s+different\s+chat|previous\s+chat|last\s+time\s+i\s+asked)\b/gi,
];

const RECALL_STOP_WORDS = new Set([
  "about", "again", "another", "asked", "asking", "before", "chat", "did", "earlier",
  "from", "have", "last", "mention", "mentioned", "me", "my", "of", "previous",
  "question", "remember", "said", "something", "tell", "that", "the", "this", "time",
  "was", "what", "when", "whether", "you",
]);

function normalizeRecallText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeRecallText(value: string): string[] {
  return normalizeRecallText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !RECALL_STOP_WORDS.has(token));
}

export function isExplicitPriorConversationRecallQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return RECALL_QUERY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function extractRecallSubject(query: string): string {
  let stripped = query.trim();
  for (const pattern of RECALL_PREFIX_PATTERNS) {
    stripped = stripped.replace(pattern, " ");
  }
  return normalizeRecallText(stripped);
}

export async function fetchPriorConversationRecallEvidence(args: {
  query: string;
  userDb?: SupabaseClient;
  userId?: string;
  currentConversationId?: string;
}): Promise<readonly ContextRecallEvidence[]> {
  if (!args.userDb || !args.userId || !isExplicitPriorConversationRecallQuery(args.query)) {
    return [];
  }

  const normalizedSubject = extractRecallSubject(args.query);
  const subjectTokens = tokenizeRecallText(normalizedSubject);
  if (!normalizedSubject || subjectTokens.length === 0) {
    return [];
  }

  const { data, error } = await getPriorConversationUserMessages(
    args.userDb,
    args.userId,
    args.currentConversationId,
  );
  if (error) {
    throw error;
  }

  const uniqueMessages = new Set<string>();
  const scored = (data ?? [])
    .map((message, index, items) => {
      const normalizedContent = normalizeRecallText(message.content || "");
      if (!normalizedContent) return null;

      const exactPhraseHit = normalizedSubject.length >= 5 && normalizedContent.includes(normalizedSubject);
      const contentTokens = new Set(tokenizeRecallText(normalizedContent));
      const overlapCount = subjectTokens.reduce((count, token) => count + (contentTokens.has(token) ? 1 : 0), 0);
      if (!exactPhraseHit && overlapCount === 0) {
        return null;
      }

      const recencyScore = Math.max(0, (items.length - index) / Math.max(items.length, 1));
      return {
        evidence: {
          conversationId: message.conversation_id,
          content: message.content,
          createdAt: message.created_at,
        } satisfies ContextRecallEvidence,
        normalizedContent,
        score: (exactPhraseHit ? 8 : 0) + overlapCount * 2 + recencyScore,
      };
    })
    .filter((item): item is { evidence: ContextRecallEvidence; normalizedContent: string; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score);

  const selected: ContextRecallEvidence[] = [];
  for (const item of scored) {
    if (uniqueMessages.has(item.normalizedContent)) continue;
    uniqueMessages.add(item.normalizedContent);
    selected.push(item.evidence);
    if (selected.length >= 3) break;
  }

  return selected;
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
  const allMessages = collapseAdjacentDuplicateMessages(raw.recent_messages ?? []);
  const query = raw.userMessage || allMessages[allMessages.length - 1]?.content || "";
  const isExplicitRecallQuery = isExplicitPriorConversationRecallQuery(query);

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
  const recallEvidencePromise = (userDb && normalizedUserId && isExplicitRecallQuery)
    ? fetchPriorConversationRecallEvidence({
      query,
      userDb,
      userId: normalizedUserId,
      currentConversationId: raw.conversationId,
    })
    : Promise.resolve([] as readonly ContextRecallEvidence[]);

  const [compressionResult, semanticResults, cloudMemories, priorConversationEvidence] = await Promise.all([
    compressConversation(allMessages, userId),
    semanticMemorySearch(rawMemories, query, 3),
    cloudMemoryPromise,
    recallEvidencePromise,
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
  const fileReferences = (raw.file_references ?? []).map((f) => ({
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
  console.log(`[CONTEXT] recall evidence selected: ${priorConversationEvidence.length}`);
  console.log(`[CONTEXT] buildContext completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages,
    memories,
    fileReferences,
    memoryPromptBlock,
    conversationSummary: summary,
    hasFileContext: fileReferences.length > 0,
    webSearchMode: raw.web_search_mode,
    userId: normalizedUserId,
    trustedProfile: raw.trustedProfile,
    priorConversationEvidence,
    isExplicitRecallQuery,
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
  const allMessages = collapseAdjacentDuplicateMessages(raw.recent_messages ?? []);
  const recentMessages = allMessages.slice(-CONVERSATION_WINDOW);
  const query = raw.userMessage || recentMessages[recentMessages.length - 1]?.content || "";
  const isExplicitRecallQuery = isExplicitPriorConversationRecallQuery(query);

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
  const recallEvidencePromise = (userDb && normalizedUserId && isExplicitRecallQuery)
    ? fetchPriorConversationRecallEvidence({
      query,
      userDb,
      userId: normalizedUserId,
      currentConversationId: raw.conversationId,
    })
    : Promise.resolve([] as readonly ContextRecallEvidence[]);

  // Use fast keyword-based memory selection (synchronous)
  let memories: readonly ContextMemory[] = selectMemoriesForQuery(rawMemories, query, 3);

  // Await cloud memories (started earlier, likely already resolved)
  const [cloudMemories, priorConversationEvidence] = await Promise.all([
    cloudMemoryPromise,
    recallEvidencePromise,
  ]);
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
  console.log(`[CONTEXT-FAST] recall evidence selected: ${priorConversationEvidence.length}`);
  console.log(`[CONTEXT-FAST] buildContextFast completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages,
    memories,
    fileReferences,
    memoryPromptBlock,
    conversationSummary: undefined, // No compression = no summary
    hasFileContext: fileReferences.length > 0,
    webSearchMode: raw.web_search_mode,
    userId: normalizedUserId,
    trustedProfile: raw.trustedProfile,
    priorConversationEvidence,
    isExplicitRecallQuery,
  };
}
