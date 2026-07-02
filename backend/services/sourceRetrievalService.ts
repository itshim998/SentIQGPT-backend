import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkSourceText } from "../context/sourceChunker";
import { estimateTextTokens, trimTextToTokenBudget } from "../orchestrator/contextBudgetManager";

export interface UploadedSourceReference {
  readonly filename: string;
  readonly extractedText: string;
  readonly analysis_id?: string;
  readonly sourceDocumentId?: string;
  readonly document_id?: string;
  readonly source_document_id?: string;
  readonly mime_type?: string;
}

export interface PromptSourceReference {
  readonly filename: string;
  readonly extractedText: string;
  readonly retrieved?: boolean;
  readonly relevance?: number;
  readonly sourceChunkCount?: number;
}

export interface SourceDocumentRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly conversation_id: string | null;
  readonly title: string;
  readonly original_filename: string;
  readonly mime_type: string;
  readonly source_type: "pdf" | "text" | "code";
  readonly content_hash: string;
  readonly status: "processing" | "ready" | "failed";
  readonly metadata: Record<string, unknown>;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly referenceIndexes?: readonly number[];
}

export interface SourceChunkInsert {
  readonly document_id: string;
  readonly owner_user_id: string;
  readonly conversation_id: string | null;
  readonly parent_chunk_id: string | null;
  readonly chunk_role: "parent" | "child";
  readonly chunk_index: number;
  readonly heading: string | null;
  readonly path: string | null;
  readonly page_number: number | null;
  readonly content: string;
  readonly context_prefix: string | null;
  readonly token_estimate: number;
  readonly embedding_status: "pending_embedding";
  readonly metadata: Record<string, unknown>;
}

export interface SourceChunkIdentity {
  readonly id: string;
  readonly chunk_index: number;
  readonly chunk_role: "parent" | "child";
}

export interface SourceChunkHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly parentChunkId: string;
  readonly title: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly contextPrefix?: string;
  readonly parentContent: string;
  readonly parentContextPrefix?: string;
  readonly heading?: string;
  readonly path?: string;
  readonly pageNumber?: number;
  readonly relevance: number;
}

export interface PersistSourceResult {
  readonly status: "persisted" | "skipped";
  readonly document?: SourceDocumentRow;
  readonly parentChunksCreated: number;
  readonly childChunksCreated: number;
  readonly reason?: string;
}

export interface RetrieveSourceResult {
  readonly mode: "none" | "legacy" | "lexical" | "semantic" | "hybrid";
  readonly fileReferences: readonly PromptSourceReference[];
  readonly resolvedDocuments: number;
  readonly selectedChunks: number;
  readonly droppedChunks: number;
}

interface SourceDocumentInsert {
  readonly owner_user_id: string;
  readonly conversation_id: string | null;
  readonly title: string;
  readonly original_filename: string;
  readonly mime_type: string;
  readonly source_type: "pdf" | "text" | "code";
  readonly content_hash: string;
  readonly status: "processing";
  readonly metadata: Record<string, unknown>;
}

export interface SourceRetrievalDependencies {
  readonly insertDocument?: (
    userDb: SupabaseClient | any,
    input: SourceDocumentInsert,
  ) => Promise<SourceDocumentRow>;
  readonly insertChunks?: (
    userDb: SupabaseClient | any,
    chunks: readonly SourceChunkInsert[],
  ) => Promise<readonly SourceChunkIdentity[]>;
  readonly updateDocumentStatus?: (
    userDb: SupabaseClient | any,
    documentId: string,
    ownerUserId: string,
    status: "ready" | "failed",
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  readonly resolveDocuments?: (args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    fileReferences: readonly UploadedSourceReference[];
  }) => Promise<readonly SourceDocumentRow[]>;
  readonly lexicalSearch?: (args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    documents: readonly SourceDocumentRow[];
    query: string;
    limit: number;
  }) => Promise<readonly SourceChunkHit[]>;
  readonly semanticSearch?: (args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    documents: readonly SourceDocumentRow[];
    query: string;
    limit: number;
  }) => Promise<readonly SourceChunkHit[]>;
}

const DOCUMENT_COLUMNS = "id,owner_user_id,conversation_id,title,original_filename,mime_type,source_type,content_hash,status,metadata,created_at,updated_at";
const MAX_RETRIEVED_CHILDREN = 10;
const MAX_RETRIEVED_PARENTS = 6;
const MAX_CHILDREN_PER_PARENT = 2;
const MAX_PARENT_EXCERPT_TOKENS = 440;
const MAX_CHILD_EXCERPT_TOKENS = 240;
const MAX_RETRIEVED_BLOCK_TOKENS = 900;
const MAX_FALLBACK_CANDIDATES = 600;
const SOURCE_INSERT_BATCH_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs",
  "rs", "go", "rb", "php", "swift", "kt", "scala", "lua", "sh", "sql",
  "r", "dart", "vue", "svelte", "html", "css", "json", "xml", "yaml", "yml",
]);

function logSource(event: string, details: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ scope: "source_retrieval", event, ...details }));
}

function isGuestIdentity(userId: string | undefined): boolean {
  const normalized = userId?.trim().toLowerCase() ?? "";
  return !normalized || normalized === "guest" || normalized.startsWith("guest-");
}

function normalizeDocument(value: unknown): SourceDocumentRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.owner_user_id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.original_filename !== "string" ||
    typeof row.mime_type !== "string" ||
    typeof row.content_hash !== "string" ||
    !["pdf", "text", "code"].includes(String(row.source_type)) ||
    !["processing", "ready", "failed"].includes(String(row.status))
  ) return undefined;
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    conversation_id: typeof row.conversation_id === "string" ? row.conversation_id : null,
    title: row.title,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    source_type: row.source_type as SourceDocumentRow["source_type"],
    content_hash: row.content_hash,
    status: row.status as SourceDocumentRow["status"],
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
    created_at: typeof row.created_at === "string" ? row.created_at : undefined,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}

function normalizeHit(value: unknown): SourceChunkHit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.chunk_id !== "string" ||
    typeof row.document_id !== "string" ||
    typeof row.parent_chunk_id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.content !== "string" ||
    typeof row.parent_content !== "string"
  ) return undefined;
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    parentChunkId: row.parent_chunk_id,
    title: row.title,
    chunkIndex: Math.max(0, Math.floor(Number(row.chunk_index) || 0)),
    content: row.content,
    contextPrefix: typeof row.context_prefix === "string" ? row.context_prefix : undefined,
    parentContent: row.parent_content,
    parentContextPrefix: typeof row.parent_context_prefix === "string" ? row.parent_context_prefix : undefined,
    heading: typeof row.heading === "string" ? row.heading : undefined,
    path: typeof row.path === "string" ? row.path : undefined,
    pageNumber: Number.isFinite(Number(row.page_number)) ? Number(row.page_number) : undefined,
    relevance: Math.max(0, Number(row.lexical_rank ?? row.relevance) || 0),
  };
}

async function defaultInsertDocument(
  userDb: SupabaseClient | any,
  input: SourceDocumentInsert,
): Promise<SourceDocumentRow> {
  const result = await userDb.from("source_documents").insert(input).select(DOCUMENT_COLUMNS).single();
  if (result.error) throw result.error;
  const document = normalizeDocument(result.data);
  if (!document) throw new Error("Invalid source document insert result");
  return document;
}

async function defaultInsertChunks(
  userDb: SupabaseClient | any,
  chunks: readonly SourceChunkInsert[],
): Promise<readonly SourceChunkIdentity[]> {
  if (chunks.length === 0) return [];
  const result = await userDb
    .from("source_chunks")
    .insert(chunks)
    .select("id,chunk_index,chunk_role");
  if (result.error) throw result.error;
  return (result.data ?? []) as SourceChunkIdentity[];
}

async function defaultUpdateDocumentStatus(
  userDb: SupabaseClient | any,
  documentId: string,
  ownerUserId: string,
  status: "ready" | "failed",
  metadata: Record<string, unknown>,
): Promise<void> {
  const result = await userDb
    .from("source_documents")
    .update({ status, metadata })
    .eq("id", documentId)
    .eq("owner_user_id", ownerUserId);
  if (result.error) throw result.error;
}

async function defaultResolveDocuments(args: {
  userDb: SupabaseClient | any;
  ownerUserId: string;
  fileReferences: readonly UploadedSourceReference[];
}): Promise<readonly SourceDocumentRow[]> {
  const explicitIds = [...new Set(args.fileReferences
    .map((reference) => reference.sourceDocumentId ?? reference.source_document_id ?? reference.document_id)
    .filter((value): value is string => typeof value === "string" && UUID_PATTERN.test(value)))];
  const analysisIds = [...new Set(args.fileReferences
    .map((reference) => reference.analysis_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0))];
  const rows: unknown[] = [];

  if (explicitIds.length > 0) {
    const result = await args.userDb
      .from("source_documents")
      .select(DOCUMENT_COLUMNS)
      .eq("owner_user_id", args.ownerUserId)
      .eq("status", "ready")
      .in("id", explicitIds);
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
  }

  if (analysisIds.length > 0) {
    const analysisResults = await Promise.all(analysisIds.map(async (analysisId) => args.userDb
      .from("source_documents")
      .select(DOCUMENT_COLUMNS)
      .eq("owner_user_id", args.ownerUserId)
      .eq("status", "ready")
      .contains("metadata", { analysis_id: analysisId })
      .limit(1)));
    const analysisError = analysisResults.find((result) => result.error)?.error;
    if (analysisError) throw analysisError;
    analysisResults.forEach((result) => rows.push(...(result.data ?? [])));
  }

  const byId = new Map<string, SourceDocumentRow>();
  rows.map(normalizeDocument).filter((row): row is SourceDocumentRow => Boolean(row)).forEach((document) => {
    const referenceIndexes = args.fileReferences.flatMap((reference, index) => {
      const explicitId = reference.sourceDocumentId ?? reference.source_document_id ?? reference.document_id;
      const analysisId = typeof document.metadata.analysis_id === "string" ? document.metadata.analysis_id : undefined;
      return explicitId === document.id || (analysisId && reference.analysis_id === analysisId) ? [index] : [];
    });
    byId.set(document.id, { ...document, referenceIndexes });
  });
  return [...byId.values()];
}

function queryTerms(query: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "what", "when", "where", "which", "about", "into", "does"]);
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter((term) => term.length > 2 && !stop.has(term)))];
}

export function scoreSourceChunkLexical(content: string, prefix: string, query: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0.01;
  const contentLower = content.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (contentLower.includes(term)) score += 1;
    if (prefixLower.includes(term)) score += 0.5;
  }
  return score / terms.length;
}

async function fallbackLexicalSearch(args: {
  userDb: SupabaseClient | any;
  ownerUserId: string;
  documents: readonly SourceDocumentRow[];
  query: string;
  limit: number;
}): Promise<readonly SourceChunkHit[]> {
  const documentIds = args.documents.map((document) => document.id);
  const documentById = new Map(args.documents.map((document) => [document.id, document]));
  const childResult = await args.userDb
    .from("source_chunks")
    .select("id,document_id,parent_chunk_id,chunk_index,heading,path,page_number,content,context_prefix,token_estimate")
    .eq("owner_user_id", args.ownerUserId)
    .eq("chunk_role", "child")
    .in("document_id", documentIds)
    .limit(MAX_FALLBACK_CANDIDATES);
  if (childResult.error) throw childResult.error;
  const children = (childResult.data ?? []) as Record<string, unknown>[];
  const parentIds = [...new Set(children
    .map((row) => row.parent_chunk_id)
    .filter((value): value is string => typeof value === "string"))];
  if (parentIds.length === 0) return [];
  const parentResult = await args.userDb
    .from("source_chunks")
    .select("id,document_id,content,context_prefix")
    .eq("owner_user_id", args.ownerUserId)
    .eq("chunk_role", "parent")
    .in("id", parentIds);
  if (parentResult.error) throw parentResult.error;
  const parents = new Map<string, Record<string, unknown>>(
    ((parentResult.data ?? []) as Record<string, unknown>[])
      .filter((row) => typeof row.id === "string")
      .map((row) => [row.id as string, row]),
  );

  return children.flatMap((child): SourceChunkHit[] => {
    const parentId = typeof child.parent_chunk_id === "string" ? child.parent_chunk_id : "";
    const documentId = typeof child.document_id === "string" ? child.document_id : "";
    const parent = parents.get(parentId);
    const document = documentById.get(documentId);
    if (!parent || !document || typeof child.id !== "string" || typeof child.content !== "string" || typeof parent.content !== "string") return [];
    const prefix = [child.context_prefix, document.title].filter((value): value is string => typeof value === "string").join(" ");
    return [{
      chunkId: child.id,
      documentId,
      parentChunkId: parentId,
      title: document.title,
      chunkIndex: Math.max(0, Math.floor(Number(child.chunk_index) || 0)),
      content: child.content,
      contextPrefix: typeof child.context_prefix === "string" ? child.context_prefix : undefined,
      parentContent: parent.content,
      parentContextPrefix: typeof parent.context_prefix === "string" ? parent.context_prefix : undefined,
      heading: typeof child.heading === "string" ? child.heading : undefined,
      path: typeof child.path === "string" ? child.path : undefined,
      pageNumber: Number.isFinite(Number(child.page_number)) ? Number(child.page_number) : undefined,
      relevance: scoreSourceChunkLexical(child.content, prefix, args.query),
    }];
  }).sort((left, right) => right.relevance - left.relevance || left.chunkIndex - right.chunkIndex)
    .slice(0, args.limit);
}

async function defaultLexicalSearch(args: {
  userDb: SupabaseClient | any;
  ownerUserId: string;
  documents: readonly SourceDocumentRow[];
  query: string;
  limit: number;
}): Promise<readonly SourceChunkHit[]> {
  const rpc = await args.userDb.rpc("search_source_chunks", {
    p_owner_user_id: args.ownerUserId,
    p_document_ids: args.documents.map((document) => document.id),
    p_query: args.query,
    p_limit: args.limit,
  });
  if (!rpc.error) {
    const hits = (rpc.data ?? []).map(normalizeHit).filter((hit: SourceChunkHit | undefined): hit is SourceChunkHit => Boolean(hit));
    if (hits.length > 0) return hits;
  } else {
    logSource("retrieval_fallback", { reason: "fts_rpc_unavailable", error_type: rpc.error.code ?? "unknown" });
  }
  return fallbackLexicalSearch(args);
}

function mergeHits(
  lexical: readonly SourceChunkHit[],
  semantic: readonly SourceChunkHit[],
): SourceChunkHit[] {
  const merged = new Map<string, SourceChunkHit & { score: number }>();
  lexical.forEach((hit, index) => {
    merged.set(hit.chunkId, { ...hit, score: hit.relevance + 1 / (60 + index) });
  });
  semantic.forEach((hit, index) => {
    const existing = merged.get(hit.chunkId);
    const semanticScore = hit.relevance + 1 / (60 + index);
    merged.set(hit.chunkId, existing
      ? { ...existing, score: existing.score + semanticScore }
      : { ...hit, score: semanticScore });
  });
  return [...merged.values()]
    .sort((left, right) => right.score - left.score || left.chunkIndex - right.chunkIndex)
    .map(({ score, ...hit }) => ({ ...hit, relevance: score }));
}

function buildRetrievedReferences(hits: readonly SourceChunkHit[]): PromptSourceReference[] {
  const grouped = new Map<string, SourceChunkHit[]>();
  hits.slice(0, MAX_RETRIEVED_CHILDREN).forEach((hit) => {
    const key = `${hit.documentId}:${hit.parentChunkId}`;
    const group = grouped.get(key) ?? [];
    if (group.length < MAX_CHILDREN_PER_PARENT) group.push(hit);
    grouped.set(key, group);
  });
  return [...grouped.values()].slice(0, MAX_RETRIEVED_PARENTS).map((group) => {
    const first = group[0];
    const prefix = first.parentContextPrefix ?? first.contextPrefix;
    const parent = trimTextToTokenBudget(first.parentContent, MAX_PARENT_EXCERPT_TOKENS, "head_tail");
    const children = group.map((hit, index) => [
      `MATCHED EXCERPT ${index + 1}:`,
      trimTextToTokenBudget(hit.content, MAX_CHILD_EXCERPT_TOKENS, "head_tail"),
    ].join("\n"));
    const content = trimTextToTokenBudget([
      prefix ? `SOURCE CONTEXT: ${prefix}` : "",
      "PARENT EXCERPT:",
      parent,
      ...children,
    ].filter(Boolean).join("\n"), MAX_RETRIEVED_BLOCK_TOKENS, "head_tail");
    return {
      filename: first.title,
      extractedText: content,
      retrieved: true,
      relevance: Math.max(...group.map((hit) => hit.relevance)),
      sourceChunkCount: group.length,
    };
  });
}

function inferSourceType(filename: string, extractionType: "pdf" | "txt"): "pdf" | "text" | "code" {
  if (extractionType === "pdf") return "pdf";
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return CODE_EXTENSIONS.has(extension) ? "code" : "text";
}

export class SourceRetrievalService {
  private readonly dependencies: Required<Omit<SourceRetrievalDependencies, "semanticSearch">>;
  private readonly semanticSearch?: NonNullable<SourceRetrievalDependencies["semanticSearch"]>;

  constructor(dependencies: SourceRetrievalDependencies = {}) {
    this.dependencies = {
      insertDocument: dependencies.insertDocument ?? defaultInsertDocument,
      insertChunks: dependencies.insertChunks ?? defaultInsertChunks,
      updateDocumentStatus: dependencies.updateDocumentStatus ?? defaultUpdateDocumentStatus,
      resolveDocuments: dependencies.resolveDocuments ?? defaultResolveDocuments,
      lexicalSearch: dependencies.lexicalSearch ?? defaultLexicalSearch,
    };
    this.semanticSearch = dependencies.semanticSearch;
  }

  async persistUploadedSource(args: {
    userDb?: SupabaseClient | any;
    ownerUserId?: string;
    conversationId?: string;
    filename: string;
    mimeType: string;
    extractionType: "pdf" | "txt" | "image";
    extractedText: string;
    sizeBytes: number;
    analysisId?: string;
  }): Promise<PersistSourceResult> {
    if (isGuestIdentity(args.ownerUserId) || !args.userDb) {
      logSource("document_skipped", { reason: "guest_or_missing_context" });
      return { status: "skipped", parentChunksCreated: 0, childChunksCreated: 0, reason: "guest_or_missing_context" };
    }
    if (args.extractionType === "image" || !args.extractedText.trim()) {
      logSource("document_skipped", { reason: "unsupported_or_empty_source" });
      return { status: "skipped", parentChunksCreated: 0, childChunksCreated: 0, reason: "unsupported_or_empty_source" };
    }

    const chunks = chunkSourceText({ text: args.extractedText, title: args.filename, path: args.filename });
    if (chunks.parents.length === 0 || chunks.children.length === 0) {
      logSource("document_skipped", { reason: "no_chunks" });
      return { status: "skipped", parentChunksCreated: 0, childChunksCreated: 0, reason: "no_chunks" };
    }
    const baseMetadata: Record<string, unknown> = {
      analysis_id: args.analysisId ?? null,
      size_bytes: args.sizeBytes,
      embedding_status: "pending_embedding",
    };
    const document = await this.dependencies.insertDocument(args.userDb, {
      owner_user_id: args.ownerUserId!,
      conversation_id: args.conversationId ?? null,
      title: args.filename,
      original_filename: args.filename,
      mime_type: args.mimeType,
      source_type: inferSourceType(args.filename, args.extractionType),
      content_hash: createHash("sha256").update(args.extractedText, "utf8").digest("hex"),
      status: "processing",
      metadata: baseMetadata,
    });

    try {
      const insertInBatches = async (inputs: readonly SourceChunkInsert[]): Promise<SourceChunkIdentity[]> => {
        const inserted: SourceChunkIdentity[] = [];
        for (let start = 0; start < inputs.length; start += SOURCE_INSERT_BATCH_SIZE) {
          const batch = inputs.slice(start, start + SOURCE_INSERT_BATCH_SIZE);
          inserted.push(...await this.dependencies.insertChunks(args.userDb, batch));
        }
        return inserted;
      };
      const childCountByParent = new Map<number, number>();
      chunks.children.forEach((child) => {
        childCountByParent.set(child.parentIndex, (childCountByParent.get(child.parentIndex) ?? 0) + 1);
      });
      const parentRows = await insertInBatches(chunks.parents.map((parent) => ({
        document_id: document.id,
        owner_user_id: args.ownerUserId!,
        conversation_id: args.conversationId ?? null,
        parent_chunk_id: null,
        chunk_role: "parent" as const,
        chunk_index: parent.index,
        heading: parent.heading ?? null,
        path: parent.path ?? null,
        page_number: parent.pageNumber ?? null,
        content: parent.content,
        context_prefix: parent.contextPrefix ?? null,
        token_estimate: Math.max(1, parent.tokenEstimate),
        embedding_status: "pending_embedding" as const,
        metadata: { child_count: childCountByParent.get(parent.index) ?? 0 },
      })));
      const parentIds = new Map(parentRows.map((parent) => [parent.chunk_index, parent.id]));
      const childInputs = chunks.children.flatMap((child): SourceChunkInsert[] => {
        const parentId = parentIds.get(child.parentIndex);
        if (!parentId) return [];
        return [{
          document_id: document.id,
          owner_user_id: args.ownerUserId!,
          conversation_id: args.conversationId ?? null,
          parent_chunk_id: parentId,
          chunk_role: "child",
          chunk_index: child.index,
          heading: child.heading ?? null,
          path: child.path ?? null,
          page_number: child.pageNumber ?? null,
          content: child.content,
          context_prefix: child.contextPrefix ?? null,
          token_estimate: Math.max(1, child.tokenEstimate),
          embedding_status: "pending_embedding",
          metadata: { parent_index: child.parentIndex },
        }];
      });
      const childRows = await insertInBatches(childInputs);
      const readyMetadata = {
        ...baseMetadata,
        parent_chunk_count: parentRows.length,
        child_chunk_count: childRows.length,
        estimated_source_tokens: estimateTextTokens(args.extractedText),
      };
      await this.dependencies.updateDocumentStatus(args.userDb, document.id, args.ownerUserId!, "ready", readyMetadata);
      const readyDocument: SourceDocumentRow = { ...document, status: "ready", metadata: readyMetadata };
      logSource("document_persisted", {
        source_type: readyDocument.source_type,
        parent_chunks_created: parentRows.length,
        child_chunks_created: childRows.length,
        embedding_status: "pending_embedding",
      });
      return {
        status: "persisted",
        document: readyDocument,
        parentChunksCreated: parentRows.length,
        childChunksCreated: childRows.length,
      };
    } catch (error) {
      await this.dependencies.updateDocumentStatus(args.userDb, document.id, args.ownerUserId!, "failed", {
        ...baseMetadata,
        failure_type: error instanceof Error ? error.name : "unknown",
      }).catch(() => undefined);
      logSource("document_skipped", {
        reason: "persistence_failed",
        error_type: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }

  async retrieveForPrompt(args: {
    userDb?: SupabaseClient | any;
    ownerUserId?: string;
    query: string;
    fileReferences: readonly UploadedSourceReference[];
  }): Promise<RetrieveSourceResult> {
    const legacyReferences = args.fileReferences
      .filter((reference) => reference.extractedText.trim().length > 0)
      .map((reference) => ({ filename: reference.filename, extractedText: reference.extractedText }));
    if (args.fileReferences.length === 0) {
      return { mode: "none", fileReferences: [], resolvedDocuments: 0, selectedChunks: 0, droppedChunks: 0 };
    }
    if (isGuestIdentity(args.ownerUserId) || !args.userDb) {
      logSource("retrieval", {
        mode: legacyReferences.length > 0 ? "legacy" : "none",
        reason: "guest_or_missing_context",
        selected_chunks: 0,
        dropped_chunks: 0,
      });
      return {
        mode: legacyReferences.length > 0 ? "legacy" : "none",
        fileReferences: legacyReferences,
        resolvedDocuments: 0,
        selectedChunks: 0,
        droppedChunks: 0,
      };
    }

    let documents: readonly SourceDocumentRow[] = [];
    try {
      documents = await this.dependencies.resolveDocuments({
        userDb: args.userDb,
        ownerUserId: args.ownerUserId!,
        fileReferences: args.fileReferences,
      });
    } catch (error) {
      logSource("retrieval_fallback", {
        reason: "document_resolution_failed",
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    if (documents.length === 0) {
      return {
        mode: legacyReferences.length > 0 ? "legacy" : "none",
        fileReferences: legacyReferences,
        resolvedDocuments: 0,
        selectedChunks: 0,
        droppedChunks: 0,
      };
    }

    const lexicalPromise = this.dependencies.lexicalSearch({
      userDb: args.userDb,
      ownerUserId: args.ownerUserId!,
      documents,
      query: args.query,
      limit: MAX_RETRIEVED_CHILDREN,
    }).catch((error) => {
      logSource("retrieval_fallback", {
        reason: "lexical_failed",
        error_type: error instanceof Error ? error.name : "unknown",
      });
      return [] as readonly SourceChunkHit[];
    });
    const semanticPromise = this.semanticSearch
      ? this.semanticSearch({
          userDb: args.userDb,
          ownerUserId: args.ownerUserId!,
          documents,
          query: args.query,
          limit: MAX_RETRIEVED_CHILDREN,
        }).catch((error) => {
          logSource("retrieval_fallback", {
            reason: "semantic_unavailable",
            error_type: error instanceof Error ? error.name : "unknown",
          });
          return [] as readonly SourceChunkHit[];
        })
      : Promise.resolve([] as readonly SourceChunkHit[]);
    const [lexical, semantic] = await Promise.all([lexicalPromise, semanticPromise]);
    const hits = mergeHits(lexical, semantic);
    if (hits.length === 0) {
      return {
        mode: legacyReferences.length > 0 ? "legacy" : "none",
        fileReferences: legacyReferences,
        resolvedDocuments: documents.length,
        selectedChunks: 0,
        droppedChunks: 0,
      };
    }

    const retrievedReferences = buildRetrievedReferences(hits);
    const usedReferenceIndexes = new Set(documents
      .filter((document) => hits.some((hit) => hit.documentId === document.id))
      .flatMap((document) => [...(document.referenceIndexes ?? [])]));
    const fallbackReferences = args.fileReferences.flatMap((reference, index): PromptSourceReference[] => {
      if (usedReferenceIndexes.has(index) || !reference.extractedText.trim()) return [];
      return [{ filename: reference.filename, extractedText: reference.extractedText }];
    });
    const mode: RetrieveSourceResult["mode"] = semantic.length > 0
      ? lexical.length > 0 ? "hybrid" : "semantic"
      : "lexical";
    const selectedChunks = retrievedReferences.reduce((sum, reference) => sum + (reference.sourceChunkCount ?? 0), 0);
    const droppedChunks = Math.max(0, hits.length - selectedChunks);
    logSource("retrieval", {
      mode,
      semantic_available: Boolean(this.semanticSearch),
      documents_resolved: documents.length,
      chunks_selected: selectedChunks,
      chunks_dropped: droppedChunks,
    });
    return {
      mode,
      fileReferences: [...retrievedReferences, ...fallbackReferences],
      resolvedDocuments: documents.length,
      selectedChunks,
      droppedChunks,
    };
  }
}

export const sourceRetrievalService = new SourceRetrievalService();
