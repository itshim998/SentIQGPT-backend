// SentIQ Chat v2 — Context Builder (with Compression + Semantic Retrieval)
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
import {
  enqueueMemoryEmbeddingBackfill,
  processQueuedMemoryEmbeddingBackfill,
} from "../memory/memoryMaintenance";
import type { WebSearchMode } from "../tools/webSearch/webSearchMode";
import { getPriorConversationUserMessages } from "../services/conversationService";
import { collapseAdjacentDuplicateMessages } from "./messageDeduper";
import { FAST_PROFILE, INTUITIVE_PROFILE, type ExecutionProfile } from "../orchestrator/executionProfile";
import type { BillingIdentity } from "../billing/entitlementTypes";
import { contextCapsuleService, type ContextCapsulePair } from "../services/contextCapsuleService";
import {
  sourceRetrievalService,
  type PromptSourceReference,
} from "../services/sourceRetrievalService";

export interface RawMessageContext {
  readonly recent_messages?: readonly { role: string; content: string }[];
  readonly memories?: readonly {
    type: string;
    summary: string;
    importance?: number;
    embedding?: readonly number[];
    scope?: "global" | "chat";
    chat_id?: string | null;
  }[];
  readonly file_references?: readonly {
    filename: string;
    extractedText: string;
    analysis_id?: string;
    sourceDocumentId?: string;
    document_id?: string;
    source_document_id?: string;
    mime_type?: string;
  }[];
  readonly image_attachments?: readonly ImageAttachmentContext[];
  readonly trustedProfile?: {
    displayName: string;
  };
  readonly web_search_mode?: WebSearchMode;
  readonly web_search_trigger?: "manual" | "auto";
  readonly userMessage?: string;
  readonly userDb?: SupabaseClient;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly billingIdentity?: BillingIdentity;
  readonly billingRequestId?: string;
  readonly clientRequestId?: string;
  readonly imageQuotaKey?: string;
}

export interface ImageAttachmentContext {
  readonly filename: string;
  readonly mime_type: "image/png" | "image/jpeg" | "image/webp";
  readonly base64: string;
  readonly size_bytes: number;
}

export interface BuiltContext {
  readonly recentMessages: readonly { role: string; content: string }[];
  readonly memories: readonly {
    type: string;
    summary: string;
    importance?: number;
    relevance?: number;
    scope?: "global" | "chat";
    chat_id?: string | null;
  }[];
  readonly fileReferences: readonly PromptSourceReference[];
  readonly imageAttachments: readonly ImageAttachmentContext[];
  readonly memoryPromptBlock: string;
  readonly conversationSummary?: string;
  readonly conversationCapsule?: string;
  readonly workspaceCapsule?: string;
  readonly hasFileContext: boolean;
  readonly webSearchMode?: WebSearchMode;
  readonly webSearchTrigger?: "manual" | "auto";
  readonly userId?: string;
  readonly userDb?: SupabaseClient;
  readonly conversationId?: string;
  readonly billingIdentity?: BillingIdentity;
  readonly billingRequestId?: string;
  readonly clientRequestId?: string;
  readonly imageQuotaKey?: string;
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

export interface BuildContextOptions {
  readonly profile?: ExecutionProfile;
}

type ContextMemory = {
  type: string;
  summary: string;
  importance?: number;
  relevance?: number;
  embedding?: readonly number[];
  scope?: "global" | "chat";
  chat_id?: string | null;
};
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
  embedding?: unknown;
  embedding_model?: string | null;
  embedding_created_at?: string | null;
  embedding_backfill_requested_at?: string | null;
  embedding_backfill_attempts?: number | null;
  embedding_backfill_last_attempt_at?: string | null;
  embedding_backfill_error?: string | null;
  scope?: "global" | "chat";
  chat_id?: string | null;
  created_at?: string;
};

function normalizeEmbedding(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const vector = value
    .map((item) => typeof item === "number" ? item : Number(item))
    .filter((item) => Number.isFinite(item));
  return vector.length === value.length ? vector : undefined;
}

async function maintainCloudMemoryEmbeddings(
  userDb: SupabaseClient,
  userId: string,
  memories: readonly CloudMemoryRow[],
): Promise<void> {
  try {
    await enqueueMemoryEmbeddingBackfill(userDb, userId, memories);
    await processQueuedMemoryEmbeddingBackfill(userDb, userId, 2);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CONTEXT] memory embedding maintenance failed userId=${userId} error=${message}`);
  }
}

async function fetchCloudMemories(
  userDb: SupabaseClient,
  userId: string,
  conversationId?: string,
): Promise<readonly ContextMemory[]> {
  const selectColumns =
    "id, summary, type, importance, embedding, embedding_model, embedding_created_at, embedding_backfill_requested_at, embedding_backfill_attempts, embedding_backfill_last_attempt_at, embedding_backfill_error, scope, chat_id, created_at";
  const globalQuery = userDb
    .from("memories")
    .select(selectColumns)
    .eq("user_id", userId)
    .eq("scope", "global")
    .order("created_at", { ascending: false })
    .limit(20);
  const chatQuery = conversationId
    ? userDb
        .from("memories")
        .select(selectColumns)
        .eq("user_id", userId)
        .eq("scope", "chat")
        .eq("chat_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(20)
    : Promise.resolve({ data: [] as CloudMemoryRow[], error: null });

  const [globalResult, chatResult] = await Promise.all([globalQuery, chatQuery]);
  if (globalResult.error) {
    throw globalResult.error;
  }
  if (chatResult.error) {
    throw chatResult.error;
  }

  const rows = [
    ...((globalResult.data ?? []) as CloudMemoryRow[]),
    ...((chatResult.data ?? []) as CloudMemoryRow[]),
  ]
    .sort((left, right) => {
      const leftTime = Date.parse(left.created_at ?? "") || 0;
      const rightTime = Date.parse(right.created_at ?? "") || 0;
      return rightTime - leftTime;
    })
    .slice(0, 20);
  await maintainCloudMemoryEmbeddings(userDb, userId, rows);

  return rows
    .map((memory) => ({
      type: memory.type,
      summary: memory.summary,
      importance: memory.importance,
      embedding: normalizeEmbedding(memory.embedding),
      scope: memory.scope === "chat" ? "chat" : "global",
      chat_id: memory.chat_id ?? null,
    }));
}

function mergeMemoryCandidates(
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
  }

  return merged;
}

function selectMemoriesForPrompt(
  candidates: readonly ContextMemory[],
  query: string,
  limit: number,
  isExplicitRecallQuery: boolean,
): readonly ContextMemory[] {
  const selected = selectMemoriesForQuery(candidates, query, limit) as ContextMemory[];
  if (!isExplicitRecallQuery) return selected;

  const recallAnchors = candidates
    .filter((memory) => {
      if (!["identity", "preference", "project"].includes(memory.type)) return false;
      return (memory.importance ?? 5) >= 7;
    })
    .sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5))
    .slice(0, limit);

  return mergeMemoryCandidates(selected, recallAnchors).slice(0, limit);
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
  options: BuildContextOptions = {},
): Promise<BuiltContext> {
  const profile = options.profile ?? INTUITIVE_PROFILE;
  const ctxStart = Date.now();

  // Derive the query early so all pipelines can use it.
  const allMessages = collapseAdjacentDuplicateMessages(raw.recent_messages ?? []);
  const query = raw.userMessage || allMessages[allMessages.length - 1]?.content || "";
  const isExplicitRecallQuery = isExplicitPriorConversationRecallQuery(query);

  const rawMemories: ContextMemory[] = (raw.memories ?? []).map((m) => ({
    type: m.type,
    summary: m.summary,
    importance: m.importance,
    embedding: m.embedding,
    scope: m.scope === "chat" ? "chat" : "global",
    chat_id: m.chat_id ?? null,
  }));

  const normalizedUserId = userId?.trim();

  // ── PARALLEL: conversation compression + semantic memory search + cloud memory fetch ──
  // All three operations are independent and can run concurrently.
  const cloudMemoryPromise = (profile.context.cloudMemories && userDb && normalizedUserId)
    ? fetchCloudMemories(userDb, normalizedUserId, raw.conversationId)
    : Promise.resolve([] as readonly ContextMemory[]);
  const recallEvidencePromise = (profile.context.priorConversationRecall && userDb && normalizedUserId && isExplicitRecallQuery)
    ? fetchPriorConversationRecallEvidence({
      query,
      userDb,
      userId: normalizedUserId,
      currentConversationId: raw.conversationId,
    })
    : Promise.resolve([] as readonly ContextRecallEvidence[]);
  const capsulePromise: Promise<ContextCapsulePair> = normalizedUserId && userDb
    ? contextCapsuleService.readCapsules({
        userDb,
        ownerUserId: normalizedUserId,
        conversationId: raw.conversationId,
      })
    : Promise.resolve(normalizedUserId
        ? contextCapsuleService.peekCachedCapsules(normalizedUserId, raw.conversationId)
        : {});
  const sourceRetrievalPromise = sourceRetrievalService.retrieveForPrompt({
    userDb,
    ownerUserId: normalizedUserId,
    query,
    fileReferences: raw.file_references ?? [],
  });

  const compressionPromise = profile.context.compressConversation
    ? compressConversation(allMessages, userId)
    : Promise.resolve({
        recentMessages: allMessages.slice(-CONVERSATION_WINDOW),
        summary: undefined as string | undefined,
      });

  const [compressionResult, cloudMemories, priorConversationEvidence, capsules, sourceRetrieval] = await Promise.all([
    compressionPromise,
    cloudMemoryPromise,
    recallEvidencePromise,
    capsulePromise,
    sourceRetrievalPromise,
  ]);

  const { recentMessages, summary } = compressionResult;

  const memoryCandidates = mergeMemoryCandidates(rawMemories, cloudMemories);
  const semanticResults = profile.context.semanticMemorySearch
    ? await semanticMemorySearch(memoryCandidates, query, 3)
    : null;
  let memories: readonly ContextMemory[];
  if (semanticResults && semanticResults.length > 0) {
    const semanticMemories = semanticResults.map((result) => ({
      ...result.memory,
      relevance: result.similarity,
    }));
    memories = isExplicitRecallQuery
      ? selectMemoriesForPrompt(mergeMemoryCandidates(semanticMemories, memoryCandidates), query, 6, true)
      : semanticMemories;
    console.log(`[CONTEXT] memory retrieval: semantic (${memories.length} selected)`);
  } else {
    memories = selectMemoriesForPrompt(memoryCandidates, query, 3, isExplicitRecallQuery);
    console.log(`[CONTEXT] memory retrieval: keyword fallback (${memories.length} selected)`);
  }

  // 3. Keep extracted text internal until token-aware prompt composition.
  //    The token-aware Context Composer chunks, ranks, and trims this text
  //    before it is injected into a model prompt.
  const fileReferences = sourceRetrieval.fileReferences;
  if (fileReferences.length > 0) {
    const totalChars = fileReferences.reduce((s, f) => s + f.extractedText.length, 0);
    console.log(`[CONTEXT] file inputs queued for token-aware composition: ${fileReferences.length} file(s), ${totalChars} total chars`);
  }
  const imageAttachments = (raw.image_attachments ?? []).map((image) => ({
    filename: image.filename,
    mime_type: image.mime_type,
    base64: image.base64,
    size_bytes: image.size_bytes,
  }));
  if (imageAttachments.length > 0) {
    console.log(`[CONTEXT] image attachments: ${imageAttachments.length}`);
  }

  // 4. Pre-build the memory prompt block
  const memoryPromptBlock = formatMemoriesForPrompt(memories);

  // Diagnostic logging
  console.log(`[CONTEXT] memory selected: ${memories.length}`);
  console.log(`[CONTEXT] messages included: ${recentMessages.length}`);
  console.log(`[CONTEXT] summary used: ${!!summary}`);
  console.log(`[CONTEXT] recall evidence selected: ${priorConversationEvidence.length}`);
  console.log(`[CONTEXT] capsules selected: conversation=${capsules.conversation ? 1 : 0} workspace=${capsules.workspace ? 1 : 0}`);
  console.log(`[CONTEXT] source retrieval: mode=${sourceRetrieval.mode} selected=${sourceRetrieval.selectedChunks} dropped=${sourceRetrieval.droppedChunks}`);
  console.log(`[CONTEXT] buildContext profile=${profile.mode} completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages,
    memories,
    fileReferences,
    imageAttachments,
    memoryPromptBlock,
    conversationSummary: summary,
    conversationCapsule: capsules.conversation?.content,
    workspaceCapsule: capsules.workspace?.content,
    hasFileContext: fileReferences.length > 0 || imageAttachments.length > 0,
    webSearchMode: raw.web_search_mode,
    webSearchTrigger: raw.web_search_trigger,
    userId: normalizedUserId,
    userDb: userDb ?? raw.userDb,
    conversationId: raw.conversationId,
    billingIdentity: raw.billingIdentity,
    billingRequestId: raw.billingRequestId,
    clientRequestId: raw.clientRequestId,
    imageQuotaKey: raw.imageQuotaKey,
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
  options: BuildContextOptions = {},
): Promise<BuiltContext> {
  const profile = options.profile ?? FAST_PROFILE;
  const ctxStart = Date.now();

  // Get recent messages directly - no compression, no LLM call
  const allMessages = collapseAdjacentDuplicateMessages(raw.recent_messages ?? []);
  const recentMessages = allMessages.slice(-CONVERSATION_WINDOW);
  const query = raw.userMessage || recentMessages[recentMessages.length - 1]?.content || "";
  const isExplicitRecallQuery = isExplicitPriorConversationRecallQuery(query);

  const rawMemories: ContextMemory[] = (raw.memories ?? []).map((m) => ({
    type: m.type,
    summary: m.summary,
    importance: m.importance,
    embedding: m.embedding,
    scope: m.scope === "chat" ? "chat" : "global",
    chat_id: m.chat_id ?? null,
  }));

  const normalizedUserId = userId?.trim();

  // Start cloud memory fetch early (async)
  const cloudMemoryPromise = (profile.context.cloudMemories && userDb && normalizedUserId)
    ? fetchCloudMemories(userDb, normalizedUserId, raw.conversationId)
    : Promise.resolve([] as readonly ContextMemory[]);
  const recallEvidencePromise = (profile.context.priorConversationRecall && userDb && normalizedUserId && isExplicitRecallQuery)
    ? fetchPriorConversationRecallEvidence({
      query,
      userDb,
      userId: normalizedUserId,
      currentConversationId: raw.conversationId,
    })
    : Promise.resolve([] as readonly ContextRecallEvidence[]);
  // Keep the Fast path free of new shard reads so capsule support cannot add
  // first-token latency. Normal context builds and background refreshes warm
  // this process-local cache for subsequent Fast turns.
  const capsulePromise: Promise<ContextCapsulePair> = Promise.resolve(normalizedUserId
    ? contextCapsuleService.peekCachedCapsules(normalizedUserId, raw.conversationId)
    : {});
  const sourceRetrievalPromise = sourceRetrievalService.retrieveForPrompt({
    userDb,
    ownerUserId: normalizedUserId,
    query,
    fileReferences: raw.file_references ?? [],
  });

  // Use fast keyword-based memory selection (synchronous)
  let memories: readonly ContextMemory[] = selectMemoriesForPrompt(rawMemories, query, 3, isExplicitRecallQuery);

  // Await cloud memories (started earlier, likely already resolved)
  const [cloudMemories, priorConversationEvidence, capsules, sourceRetrieval] = await Promise.all([
    cloudMemoryPromise,
    recallEvidencePromise,
    capsulePromise,
    sourceRetrievalPromise,
  ]);
  if (cloudMemories.length > 0) {
    memories = selectMemoriesForPrompt(mergeMemoryCandidates(memories, cloudMemories), query, 6, isExplicitRecallQuery);
  }

  // Preserve extracted text internally; prompt composition performs chunk selection.
  const fileReferences = sourceRetrieval.fileReferences;
  const imageAttachments = (raw.image_attachments ?? []).map((image) => ({
    filename: image.filename,
    mime_type: image.mime_type,
    base64: image.base64,
    size_bytes: image.size_bytes,
  }));

  // Pre-build the memory prompt block
  const memoryPromptBlock = formatMemoriesForPrompt(memories);

  console.log(`[CONTEXT-FAST] memory selected: ${memories.length} (keyword)`);
  console.log(`[CONTEXT-FAST] messages included: ${recentMessages.length}`);
  console.log(`[CONTEXT-FAST] recall evidence selected: ${priorConversationEvidence.length}`);
  console.log(`[CONTEXT-FAST] capsules selected: conversation=${capsules.conversation ? 1 : 0} workspace=${capsules.workspace ? 1 : 0}`);
  console.log(`[CONTEXT-FAST] source retrieval: mode=${sourceRetrieval.mode} selected=${sourceRetrieval.selectedChunks} dropped=${sourceRetrieval.droppedChunks}`);
  console.log(`[CONTEXT-FAST] profile=${profile.mode} buildContextFast completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages,
    memories,
    fileReferences,
    imageAttachments,
    memoryPromptBlock,
    conversationSummary: undefined, // No compression = no summary
    conversationCapsule: capsules.conversation?.content,
    workspaceCapsule: capsules.workspace?.content,
    hasFileContext: fileReferences.length > 0 || imageAttachments.length > 0,
    webSearchMode: raw.web_search_mode,
    webSearchTrigger: raw.web_search_trigger,
    userId: normalizedUserId,
    userDb: userDb ?? raw.userDb,
    conversationId: raw.conversationId,
    billingIdentity: raw.billingIdentity,
    billingRequestId: raw.billingRequestId,
    clientRequestId: raw.clientRequestId,
    imageQuotaKey: raw.imageQuotaKey,
    trustedProfile: raw.trustedProfile,
    priorConversationEvidence,
    isExplicitRecallQuery,
  };
}
