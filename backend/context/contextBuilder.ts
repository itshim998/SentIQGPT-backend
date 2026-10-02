// SentIQ Chat v2 — Context Builder (compression, hybrid memory, continuity).
//
// Fast mode uses one bounded read-only snapshot RPC. Intuitive mode performs
// lexical continuity selection in parallel with its existing context reads; no
// additional model or embedding call is introduced.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatMemoriesForPrompt } from "../memory/memoryStore";
import { compressConversation, CONVERSATION_WINDOW } from "./contextCompressor";
import { semanticMemorySearch } from "../memory/semanticSearch";
import { fuseMemoryRetrieval, type HybridMemoryCandidate } from "../memory/hybridRetrieval";
import type { WebSearchMode } from "../tools/webSearch/webSearchMode";
import { getPriorConversationUserMessages } from "../services/conversationService";
import { searchUserMemoriesLexically } from "../services/memoryService";
import { collapseAdjacentDuplicateMessages } from "./messageDeduper";
import { FAST_PROFILE, INTUITIVE_PROFILE, type ExecutionProfile } from "../orchestrator/executionProfile";
import type { BillingIdentity } from "../billing/entitlementTypes";
import { contextCapsuleService, type ContextCapsulePair } from "../services/contextCapsuleService";
import { sourceRetrievalService, type PromptSourceReference } from "../services/sourceRetrievalService";
import {
  collectSourceDocumentIds,
  fetchFastContextSnapshot,
  mergeServerAuthoritativeMessages,
  type FastContextSnapshotFetchResult,
  type FastSnapshotSourceDocument,
} from "../services/fastContextSnapshotService";
import {
  fetchCrossConversationContinuity,
  formatCrossConversationContinuityForPrompt,
  type CrossConversationContinuity,
} from "../services/contextContinuityService";

export interface RawMessageContext {
  readonly recent_messages?: readonly { role: string; content: string }[];
  readonly memories?: readonly {
    id?: string;
    type: string;
    summary: string;
    importance?: number;
    embedding?: readonly number[];
    scope?: "global" | "chat";
    chat_id?: string | null;
    subject_key?: string;
    fact_type?: string;
    status?: string;
    last_confirmed_at?: string;
    confidence?: number;
    project_scope?: string | null;
    temporal_scope?: string | null;
  }[];
  readonly file_references?: readonly {
    filename: string;
    extractedText: string;
    analysis_id?: string;
    sourceDocumentId?: string;
    document_id?: string;
    source_document_id?: string;
    mime_type?: string;
    asset_id?: string;
    visual_asset_id?: string;
    visual_required?: boolean;
    visual_analysis_status?: string;
  }[];
  readonly image_attachments?: readonly ImageAttachmentContext[];
  readonly trustedProfile?: { displayName: string };
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
  readonly mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/heic" | "image/heif";
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
  readonly sourceDocumentIdentities?: readonly FastSnapshotSourceDocument[];
  readonly fastContextSnapshot?: {
    readonly status: FastContextSnapshotFetchResult["status"];
    readonly elapsedMs: number;
    readonly timeoutMs: number;
    readonly messageCursorId?: string;
    readonly messageCursorCreatedAt?: string;
    readonly conversationCapsuleVersion?: number;
    readonly workspaceCapsuleVersion?: number;
  };
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
  readonly trustedProfile?: { displayName: string };
  readonly priorConversationEvidence: readonly {
    conversationId: string;
    content: string;
    createdAt: string;
    messageId?: string;
    role?: "user" | "assistant";
  }[];
  readonly isExplicitRecallQuery: boolean;
}

export interface BuildContextOptions {
  readonly profile?: ExecutionProfile;
  readonly fastSnapshotPromise?: Promise<FastContextSnapshotFetchResult>;
  readonly fastSnapshotTimeoutMs?: number;
}

type ContextMemory = HybridMemoryCandidate;
type ContextRecallEvidence = {
  conversationId: string;
  content: string;
  createdAt: string;
  messageId?: string;
  role?: "user" | "assistant";
};
type ScoredRecallEvidence = {
  evidence: ContextRecallEvidence;
  normalizedContent: string;
  score: number;
};

function normalizeEmbedding(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const vector = value
    .map((item) => typeof item === "number" ? item : Number(item))
    .filter((item) => Number.isFinite(item));
  return vector.length === value.length ? vector : undefined;
}

function rawMemoryCandidates(raw: RawMessageContext): ContextMemory[] {
  return (raw.memories ?? []).map((memory) => ({
    id: memory.id,
    type: memory.type,
    summary: memory.summary,
    importance: memory.importance,
    embedding: memory.embedding,
    scope: memory.scope === "chat" ? "chat" : "global",
    chat_id: memory.chat_id ?? null,
    subject_key: memory.subject_key,
    fact_type: memory.fact_type,
    status: memory.status,
    last_confirmed_at: memory.last_confirmed_at,
    confidence: memory.confidence,
    project_scope: memory.project_scope,
    temporal_scope: memory.temporal_scope,
  }));
}

async function fetchCloudMemories(
  userDb: SupabaseClient,
  userId: string,
  query: string,
  conversationId?: string,
): Promise<readonly ContextMemory[]> {
  const { data: rows, error } = await searchUserMemoriesLexically({
    userDb,
    userId,
    query,
    conversationId,
    limit: 24,
  });
  if (error) throw error;
  return rows.map((memory) => ({
    id: memory.id,
    type: memory.type,
    summary: memory.summary,
    importance: memory.importance,
    embedding: normalizeEmbedding(memory.embedding),
    scope: memory.scope === "chat" ? "chat" : "global",
    chat_id: memory.chat_id ?? null,
    created_at: memory.created_at,
    subject_key: memory.subject_key ?? undefined,
    fact_type: memory.fact_type ?? undefined,
    last_confirmed_at: memory.last_confirmed_at ?? undefined,
    status: memory.status ?? undefined,
    confidence: memory.confidence ?? undefined,
    project_scope: memory.project_scope ?? undefined,
    temporal_scope: memory.temporal_scope ?? undefined,
    exact_phrase_match: memory.exact_phrase_match,
    entity_or_project_match: memory.entity_or_project_match,
    lexical_rank: memory.lexical_rank,
    retrieval_rank: memory.retrieval_rank,
    anchor_rank: memory.anchor_rank,
  }));
}

function mergeMemoryCandidates(
  localMemories: readonly ContextMemory[],
  cloudMemories: readonly ContextMemory[],
): readonly ContextMemory[] {
  const merged: ContextMemory[] = [];
  const seen = new Set<string>();
  for (const memory of [...localMemories, ...cloudMemories]) {
    if (!memory.summary || memory.status === "superseded") continue;
    const identity = memory.id
      ? `id:${memory.id}`
      : `summary:${memory.summary.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(memory);
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
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}
function tokenizeRecallText(value: string): string[] {
  return normalizeRecallText(value).split(" ")
    .filter((token) => token.length >= 3 && !RECALL_STOP_WORDS.has(token));
}
export function isExplicitPriorConversationRecallQuery(query: string): boolean {
  const trimmed = query.trim();
  return Boolean(trimmed) && RECALL_QUERY_PATTERNS.some((pattern) => pattern.test(trimmed));
}
function extractRecallSubject(query: string): string {
  let stripped = query.trim();
  for (const pattern of RECALL_PREFIX_PATTERNS) stripped = stripped.replace(pattern, " ");
  return normalizeRecallText(stripped);
}

export async function fetchPriorConversationRecallEvidence(args: {
  query: string;
  userDb?: SupabaseClient;
  userId?: string;
  currentConversationId?: string;
}): Promise<readonly ContextRecallEvidence[]> {
  if (!args.userDb || !args.userId || !isExplicitPriorConversationRecallQuery(args.query)) return [];
  const normalizedSubject = extractRecallSubject(args.query);
  const subjectTokens = tokenizeRecallText(normalizedSubject);
  if (!normalizedSubject || subjectTokens.length === 0) return [];
  const { data, error } = await getPriorConversationUserMessages(
    args.userDb,
    args.userId,
    args.currentConversationId,
  );
  if (error) throw error;

  const uniqueMessages = new Set<string>();
  const scored = (data ?? []).flatMap<ScoredRecallEvidence>((message, index, items) => {
    const normalizedContent = normalizeRecallText(message.content || "");
    if (!normalizedContent) return [];
    const exactPhraseHit = normalizedSubject.length >= 5 && normalizedContent.includes(normalizedSubject);
    const contentTokens = new Set(tokenizeRecallText(normalizedContent));
    const overlapCount = subjectTokens.reduce((count, token) => count + (contentTokens.has(token) ? 1 : 0), 0);
    if (!exactPhraseHit && overlapCount === 0) return [];
    const recencyScore = Math.max(0, (items.length - index) / Math.max(items.length, 1));
    return [{
      evidence: {
        conversationId: message.conversation_id,
        content: message.content,
        createdAt: message.created_at,
        role: "user" as const,
      },
      normalizedContent,
      score: (exactPhraseHit ? 8 : 0) + overlapCount * 2 + recencyScore,
    }];
  }).sort((left, right) => right.score - left.score);

  const selected: ContextRecallEvidence[] = [];
  for (const item of scored) {
    if (uniqueMessages.has(item.normalizedContent)) continue;
    uniqueMessages.add(item.normalizedContent);
    selected.push(item.evidence);
    if (selected.length >= 3) break;
  }
  return selected;
}

function continuityEvidence(continuity: CrossConversationContinuity): readonly ContextRecallEvidence[] {
  return continuity.sourceEvidence.map((evidence) => ({
    conversationId: evidence.conversationId,
    messageId: evidence.messageId,
    role: evidence.role,
    content: evidence.content,
    createdAt: evidence.createdAt,
  }));
}

function imageAttachments(raw: RawMessageContext): readonly ImageAttachmentContext[] {
  return (raw.image_attachments ?? []).map((image) => ({
    filename: image.filename,
    mime_type: image.mime_type,
    base64: image.base64,
    size_bytes: image.size_bytes,
  }));
}

export async function buildContext(
  raw: RawMessageContext,
  userDb?: SupabaseClient,
  userId?: string,
  options: BuildContextOptions = {},
): Promise<BuiltContext> {
  const profile = options.profile ?? INTUITIVE_PROFILE;
  const ctxStart = Date.now();
  const allMessages = collapseAdjacentDuplicateMessages(raw.recent_messages ?? []);
  const query = raw.userMessage || allMessages[allMessages.length - 1]?.content || "";
  const isExplicitRecallQuery = isExplicitPriorConversationRecallQuery(query);
  const normalizedUserId = userId?.trim();
  const effectiveUserDb = userDb ?? raw.userDb;
  const localMemories = rawMemoryCandidates(raw);

  const cloudMemoryPromise = profile.context.cloudMemories && effectiveUserDb && normalizedUserId
    ? fetchCloudMemories(effectiveUserDb, normalizedUserId, query, raw.conversationId)
    : Promise.resolve([] as readonly ContextMemory[]);
  const continuityPromise = profile.context.priorConversationRecall && effectiveUserDb && normalizedUserId
    ? fetchCrossConversationContinuity({
        userDb: effectiveUserDb,
        ownerUserId: normalizedUserId,
        query,
        currentConversationId: raw.conversationId,
      })
    : Promise.resolve({
        status: "skipped" as const,
        continuity: {
          schemaVersion: 1,
          stableFacts: [],
          projectCapsules: [],
          unresolvedWork: [],
          sourceEvidence: [],
        },
      });
  const capsulePromise: Promise<ContextCapsulePair> = normalizedUserId && effectiveUserDb
    ? contextCapsuleService.readCapsules({
        userDb: effectiveUserDb,
        ownerUserId: normalizedUserId,
        conversationId: raw.conversationId,
      })
    : Promise.resolve(normalizedUserId
        ? contextCapsuleService.peekCachedCapsules(normalizedUserId, raw.conversationId)
        : {});
  const sourceRetrievalPromise = sourceRetrievalService.retrieveForPrompt({
    userDb: effectiveUserDb,
    ownerUserId: normalizedUserId,
    query,
    fileReferences: raw.file_references ?? [],
  });
  const compressionPromise = profile.context.compressConversation
    ? compressConversation(allMessages, userId)
    : Promise.resolve({ recentMessages: allMessages.slice(-CONVERSATION_WINDOW), summary: undefined });

  const [compressionResult, cloudMemories, continuityResult, capsules, sourceRetrieval] = await Promise.all([
    compressionPromise,
    cloudMemoryPromise,
    continuityPromise,
    capsulePromise,
    sourceRetrievalPromise,
  ]);

  let priorConversationEvidence = continuityEvidence(continuityResult.continuity);
  if (isExplicitRecallQuery && priorConversationEvidence.length === 0) {
    priorConversationEvidence = await fetchPriorConversationRecallEvidence({
      query,
      userDb: effectiveUserDb,
      userId: normalizedUserId,
      currentConversationId: raw.conversationId,
    });
  }

  const memoryCandidates = mergeMemoryCandidates(localMemories, cloudMemories);
  const semanticResults = profile.context.semanticMemorySearch
    ? await semanticMemorySearch(memoryCandidates, query, Math.min(memoryCandidates.length, 12))
    : null;
  const memories = fuseMemoryRetrieval({
    candidates: memoryCandidates,
    semanticResults,
    query,
    conversationId: raw.conversationId,
    limit: isExplicitRecallQuery ? 6 : 5,
  }) as readonly ContextMemory[];
  const continuityBlock = formatCrossConversationContinuityForPrompt(continuityResult.continuity);
  const files = sourceRetrieval.fileReferences;
  const images = imageAttachments(raw);

  console.log(
    `[CONTEXT] memory candidates=${memoryCandidates.length} semantic=${semanticResults?.length ?? 0} selected=${memories.length}`,
  );
  console.log(
    `[CONTEXT] continuity status=${continuityResult.status} projects=${continuityResult.continuity.projectCapsules.length} `
    + `sources=${priorConversationEvidence.length} unresolved=${continuityResult.continuity.unresolvedWork.length}`,
  );
  console.log(`[CONTEXT] buildContext profile=${profile.mode} completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages: compressionResult.recentMessages,
    memories,
    fileReferences: files,
    imageAttachments: images,
    memoryPromptBlock: formatMemoriesForPrompt(memories),
    conversationSummary: compressionResult.summary,
    conversationCapsule: capsules.conversation?.content,
    workspaceCapsule: continuityBlock ?? capsules.workspace?.content,
    hasFileContext: files.length > 0 || images.length > 0,
    webSearchMode: raw.web_search_mode,
    webSearchTrigger: raw.web_search_trigger,
    userId: normalizedUserId,
    userDb: effectiveUserDb,
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

export async function buildContextFast(
  raw: RawMessageContext,
  userDb?: SupabaseClient,
  userId?: string,
  options: BuildContextOptions = {},
): Promise<BuiltContext> {
  const profile = options.profile ?? FAST_PROFILE;
  const ctxStart = Date.now();
  const clientMessages = collapseAdjacentDuplicateMessages(raw.recent_messages ?? []);
  const query = raw.userMessage || clientMessages[clientMessages.length - 1]?.content || "";
  const isExplicitRecallQuery = isExplicitPriorConversationRecallQuery(query);
  const normalizedUserId = userId?.trim();
  const effectiveUserDb = userDb ?? raw.userDb;
  const cachedCapsules = normalizedUserId
    ? contextCapsuleService.peekCachedCapsules(normalizedUserId, raw.conversationId)
    : {};
  const sourceDocumentIds = collectSourceDocumentIds(
    (raw.file_references ?? []) as unknown as readonly Record<string, unknown>[],
  );
  const snapshotPromise = options.fastSnapshotPromise ?? fetchFastContextSnapshot({
    userDb: effectiveUserDb,
    ownerUserId: normalizedUserId,
    conversationId: raw.conversationId,
    query,
    clientRequestId: raw.clientRequestId,
    sourceDocumentIds,
    timeoutMs: options.fastSnapshotTimeoutMs,
  });
  const sourceRetrievalPromise = sourceRetrievalService.retrieveForPrompt({
    userDb: effectiveUserDb,
    ownerUserId: normalizedUserId,
    query,
    fileReferences: raw.file_references ?? [],
  });
  const [snapshotResult, sourceRetrieval] = await Promise.all([snapshotPromise, sourceRetrievalPromise]);
  const snapshot = snapshotResult.status === "available" ? snapshotResult.snapshot : undefined;
  const recentMessages = snapshot
    ? mergeServerAuthoritativeMessages({
        canonicalMessages: snapshot.messages,
        clientMessages,
        currentUserMessage: raw.userMessage,
        limit: CONVERSATION_WINDOW,
      })
    : clientMessages.slice(-CONVERSATION_WINDOW);

  const snapshotMemories: ContextMemory[] = (snapshot?.memories ?? []).map((memory) => ({
    id: memory.id,
    type: memory.type,
    summary: memory.summary,
    importance: memory.importance,
    relevance: memory.lexicalRank,
    scope: memory.scope,
    chat_id: memory.chatId ?? null,
    created_at: memory.createdAt,
    subject_key: memory.subjectKey,
    fact_type: memory.factType,
    last_confirmed_at: memory.lastConfirmedAt,
    status: memory.status,
    confidence: memory.confidence,
    project_scope: memory.projectScope,
    temporal_scope: memory.temporalScope,
    exact_phrase_match: memory.exactPhraseMatch,
    entity_or_project_match: memory.entityOrProjectMatch,
    lexical_rank: memory.lexicalRank,
    retrieval_rank: memory.retrievalRank,
    anchor_rank: memory.anchorRank,
  }));
  const memoryCandidates = mergeMemoryCandidates(rawMemoryCandidates(raw), snapshotMemories);
  const memories = fuseMemoryRetrieval({
    candidates: memoryCandidates,
    query,
    conversationId: raw.conversationId,
    limit: snapshotMemories.length > 0 ? 6 : 3,
  }) as readonly ContextMemory[];
  const files = sourceRetrieval.fileReferences;
  const images = imageAttachments(raw);
  const conversationCapsule = snapshot?.conversationCapsule?.content ?? cachedCapsules.conversation?.content;
  const workspaceCapsule = snapshot?.workspaceCapsule?.content ?? cachedCapsules.workspace?.content;

  console.log(`[CONTEXT-FAST] snapshot status=${snapshotResult.status} elapsed=${snapshotResult.elapsedMs}ms`);
  console.log(`[CONTEXT-FAST] profile=${profile.mode} completed in ${Date.now() - ctxStart}ms`);

  return {
    recentMessages,
    memories,
    fileReferences: files,
    imageAttachments: images,
    memoryPromptBlock: formatMemoriesForPrompt(memories),
    conversationSummary: undefined,
    conversationCapsule,
    workspaceCapsule,
    sourceDocumentIdentities: snapshot?.sourceDocuments ?? [],
    fastContextSnapshot: {
      status: snapshotResult.status,
      elapsedMs: snapshotResult.elapsedMs,
      timeoutMs: snapshotResult.timeoutMs,
      messageCursorId: snapshot?.cursors.messageId,
      messageCursorCreatedAt: snapshot?.cursors.messageCreatedAt,
      conversationCapsuleVersion: snapshot?.cursors.conversationCapsuleVersion,
      workspaceCapsuleVersion: snapshot?.cursors.workspaceCapsuleVersion,
    },
    hasFileContext: files.length > 0 || images.length > 0,
    webSearchMode: raw.web_search_mode,
    webSearchTrigger: raw.web_search_trigger,
    userId: normalizedUserId,
    userDb: effectiveUserDb,
    conversationId: raw.conversationId,
    billingIdentity: raw.billingIdentity,
    billingRequestId: raw.billingRequestId,
    clientRequestId: raw.clientRequestId,
    imageQuotaKey: raw.imageQuotaKey,
    trustedProfile: raw.trustedProfile,
    priorConversationEvidence: [],
    isExplicitRecallQuery,
  };
}
