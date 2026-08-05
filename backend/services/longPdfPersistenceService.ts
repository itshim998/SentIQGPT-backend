import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkSourceText } from "../context/sourceChunker";
import type { PendingPdfCanonicalSource } from "../ai/pdfCanonicalSourceRegistry";
import type {
  PersistSourceResult,
  SourceChunkIdentity,
  SourceChunkInsert,
  SourceDocumentRow,
} from "./sourceRetrievalService";

export interface LongPdfDocumentInsert {
  readonly owner_user_id: string;
  readonly conversation_id: string | null;
  readonly title: string;
  readonly original_filename: string;
  readonly mime_type: string;
  readonly source_type: "pdf";
  readonly content_hash: string;
  readonly status: "processing";
  readonly metadata: Record<string, unknown>;
}

export interface LongPdfPersistenceDependencies {
  readonly insertDocument: (
    userDb: SupabaseClient | any,
    input: LongPdfDocumentInsert,
  ) => Promise<SourceDocumentRow>;
  readonly insertChunks: (
    userDb: SupabaseClient | any,
    chunks: readonly SourceChunkInsert[],
  ) => Promise<readonly SourceChunkIdentity[]>;
  readonly updateDocumentStatus: (
    userDb: SupabaseClient | any,
    documentId: string,
    ownerUserId: string,
    status: "ready" | "failed",
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  readonly updateDocumentProgress: (
    userDb: SupabaseClient | any,
    documentId: string,
    ownerUserId: string,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  readonly findExistingDocuments: (
    userDb: SupabaseClient | any,
    ownerUserId: string,
    contentHash: string,
  ) => Promise<readonly SourceDocumentRow[]>;
  readonly deleteDocument: (
    userDb: SupabaseClient | any,
    documentId: string,
    ownerUserId: string,
  ) => Promise<void>;
}

export interface PersistCanonicalPdfArgs {
  readonly userDb: SupabaseClient | any;
  readonly ownerUserId: string;
  readonly conversationId?: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly analysisId?: string;
  readonly source: PendingPdfCanonicalSource;
}

const DEFAULT_INSERT_BATCH_SIZE = 100;
const DEFAULT_PROGRESS_PAGE_BATCH = 8;
const DEFAULT_MAX_STORED_TOKENS = 1_000_000;
const DEFAULT_STALE_PROCESSING_MS = 15 * 60_000;

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function getInsertBatchSize(): number {
  return readBoundedInteger(
    process.env.SENTIQ_SOURCE_INSERT_BATCH_SIZE,
    DEFAULT_INSERT_BATCH_SIZE,
    10,
    500,
  );
}

function getProgressPageBatch(): number {
  return readBoundedInteger(
    process.env.SENTIQ_PDF_PROGRESS_PAGE_BATCH,
    DEFAULT_PROGRESS_PAGE_BATCH,
    1,
    100,
  );
}

function getMaxStoredTokens(): number {
  return readBoundedInteger(
    process.env.SENTIQ_PDF_MAX_STORED_TOKENS,
    DEFAULT_MAX_STORED_TOKENS,
    50_000,
    5_000_000,
  );
}

function getStaleProcessingMs(): number {
  return readBoundedInteger(
    process.env.SENTIQ_SOURCE_PROCESSING_STALE_MS,
    DEFAULT_STALE_PROCESSING_MS,
    60_000,
    24 * 60 * 60_000,
  );
}

function numberFromMetadata(metadata: Record<string, unknown>, key: string): number {
  const value = Number(metadata[key]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isStaleProcessing(document: SourceDocumentRow): boolean {
  if (document.status !== "processing") return false;
  const updatedAt = Date.parse(document.updated_at ?? document.created_at ?? "");
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt >= getStaleProcessingMs();
}

function selectExistingDocument(
  documents: readonly SourceDocumentRow[],
): SourceDocumentRow | undefined {
  const ready = documents.find((document) => document.status === "ready");
  if (ready) return ready;
  const processing = documents.find((document) => document.status === "processing");
  if (processing) return processing;
  return documents.find((document) => document.status === "failed");
}

async function insertInBatches(
  userDb: SupabaseClient | any,
  inputs: readonly SourceChunkInsert[],
  insertChunks: LongPdfPersistenceDependencies["insertChunks"],
): Promise<SourceChunkIdentity[]> {
  const inserted: SourceChunkIdentity[] = [];
  const batchSize = getInsertBatchSize();
  for (let start = 0; start < inputs.length; start += batchSize) {
    inserted.push(...await insertChunks(userDb, inputs.slice(start, start + batchSize)));
  }
  return inserted;
}

function buildProgressMetadata(args: {
  readonly baseMetadata: Record<string, unknown>;
  readonly source: PendingPdfCanonicalSource;
  readonly processedPages: number;
  readonly indexedPages: number;
  readonly emptyPages: number;
  readonly failedPages: readonly number[];
  readonly parentChunks: number;
  readonly childChunks: number;
  readonly canonicalCharacters: number;
  readonly estimatedSourceTokens: number;
  readonly tokenLimitExceeded: boolean;
  readonly ingestionStatus: "processing" | "ready" | "partial" | "ocr_required" | "failed";
}): Record<string, unknown> {
  return {
    ...args.baseMetadata,
    ingestion_status: args.ingestionStatus,
    declared_page_count: args.source.declaredPageCount,
    page_count: args.source.pageCount,
    processed_page_count: args.processedPages,
    indexed_page_count: args.indexedPages,
    empty_page_count: args.emptyPages,
    failed_page_count: args.failedPages.length,
    failed_pages: args.failedPages.slice(0, 100),
    page_limit_exceeded: args.source.pageLimitExceeded,
    token_limit_exceeded: args.tokenLimitExceeded,
    progress_percent: args.source.pageCount > 0
      ? Math.min(100, Math.floor((args.processedPages / args.source.pageCount) * 100))
      : 0,
    parent_chunk_count: args.parentChunks,
    child_chunk_count: args.childChunks,
    canonical_character_count: args.canonicalCharacters,
    estimated_source_tokens: args.estimatedSourceTokens,
    ocr_required: args.ingestionStatus === "ocr_required",
    embedding_status: args.childChunks > 0 ? "pending_embedding" : "not_applicable",
  };
}

export async function persistCanonicalPdfSource(
  args: PersistCanonicalPdfArgs,
  dependencies: LongPdfPersistenceDependencies,
): Promise<PersistSourceResult> {
  const existingDocuments = await dependencies.findExistingDocuments(
    args.userDb,
    args.ownerUserId,
    args.source.contentHash,
  );
  const existing = selectExistingDocument(existingDocuments);
  if (existing?.status === "ready") {
    return {
      status: "persisted",
      document: existing,
      parentChunksCreated: numberFromMetadata(existing.metadata, "parent_chunk_count"),
      childChunksCreated: numberFromMetadata(existing.metadata, "child_chunk_count"),
      reason: "content_hash_reused",
    };
  }
  if (existing?.status === "processing" && !isStaleProcessing(existing)) {
    return {
      status: "persisted",
      document: existing,
      parentChunksCreated: numberFromMetadata(existing.metadata, "parent_chunk_count"),
      childChunksCreated: numberFromMetadata(existing.metadata, "child_chunk_count"),
      reason: "already_processing",
    };
  }
  for (const staleOrFailed of existingDocuments.filter((document) =>
    document.status === "failed" || isStaleProcessing(document))) {
    await dependencies.deleteDocument(
      args.userDb,
      staleOrFailed.id,
      args.ownerUserId,
    ).catch(() => undefined);
  }

  const baseMetadata: Record<string, unknown> = {
    analysis_id: args.analysisId ?? null,
    size_bytes: args.sizeBytes,
    canonical_content_hash: args.source.contentHash,
    preview_character_count: args.source.previewText.length,
    ingestion_version: 2,
    extraction_mode: "page_by_page",
    started_at: new Date().toISOString(),
  };
  const document = await dependencies.insertDocument(args.userDb, {
    owner_user_id: args.ownerUserId,
    conversation_id: args.conversationId ?? null,
    title: args.filename,
    original_filename: args.filename,
    mime_type: args.mimeType,
    source_type: "pdf",
    content_hash: args.source.contentHash,
    status: "processing",
    metadata: buildProgressMetadata({
      baseMetadata,
      source: args.source,
      processedPages: 0,
      indexedPages: 0,
      emptyPages: 0,
      failedPages: [],
      parentChunks: 0,
      childChunks: 0,
      canonicalCharacters: 0,
      estimatedSourceTokens: 0,
      tokenLimitExceeded: false,
      ingestionStatus: "processing",
    }),
  });

  let processedPages = 0;
  let indexedPages = 0;
  let emptyPages = 0;
  const failedPages: number[] = [];
  let parentChunksCreated = 0;
  let childChunksCreated = 0;
  let parentIndexOffset = 0;
  let childIndexOffset = 0;
  let canonicalCharacters = 0;
  let estimatedSourceTokens = 0;
  let tokenLimitExceeded = false;
  const maxStoredTokens = getMaxStoredTokens();
  const progressPageBatch = getProgressPageBatch();

  try {
    for (let pageNumber = 1; pageNumber <= args.source.pageCount; pageNumber += 1) {
      const page = await args.source.readPage(pageNumber);
      processedPages += 1;
      if (page.extractionStatus === "failed") {
        failedPages.push(pageNumber);
      } else if (page.extractionStatus === "empty") {
        emptyPages += 1;
      } else {
        const pageChunks = chunkSourceText({
          text: page.text,
          title: args.filename,
          path: `${args.filename} > Page ${pageNumber}`,
          pageNumber,
        });
        const pageTokenEstimate = pageChunks.parents.reduce(
          (sum, parent) => sum + Math.max(1, parent.tokenEstimate),
          0,
        );
        if (estimatedSourceTokens + pageTokenEstimate > maxStoredTokens) {
          tokenLimitExceeded = true;
          break;
        }

        const globalParents = pageChunks.parents.map((parent) => ({
          ...parent,
          index: parent.index + parentIndexOffset,
        }));
        const globalChildren = pageChunks.children.map((child) => ({
          ...child,
          index: child.index + childIndexOffset,
          parentIndex: child.parentIndex + parentIndexOffset,
        }));
        const childCountByParent = new Map<number, number>();
        globalChildren.forEach((child) => {
          childCountByParent.set(
            child.parentIndex,
            (childCountByParent.get(child.parentIndex) ?? 0) + 1,
          );
        });

        const parentRows = await insertInBatches(
          args.userDb,
          globalParents.map((parent): SourceChunkInsert => ({
            document_id: document.id,
            owner_user_id: args.ownerUserId,
            conversation_id: args.conversationId ?? null,
            parent_chunk_id: null,
            chunk_role: "parent",
            chunk_index: parent.index,
            heading: parent.heading ?? null,
            path: parent.path ?? null,
            page_number: pageNumber,
            content: parent.content,
            context_prefix: parent.contextPrefix ?? null,
            token_estimate: Math.max(1, parent.tokenEstimate),
            embedding_status: "pending_embedding",
            metadata: {
              child_count: childCountByParent.get(parent.index) ?? 0,
              page_start: pageNumber,
              page_end: pageNumber,
              parent_index: parent.index,
              extraction_status: page.extractionStatus,
            },
          })),
          dependencies.insertChunks,
        );
        const parentIds = new Map(parentRows.map((parent) => [parent.chunk_index, parent.id]));
        const childInputs = globalChildren.flatMap((child): SourceChunkInsert[] => {
          const parentId = parentIds.get(child.parentIndex);
          if (!parentId) return [];
          return [{
            document_id: document.id,
            owner_user_id: args.ownerUserId,
            conversation_id: args.conversationId ?? null,
            parent_chunk_id: parentId,
            chunk_role: "child",
            chunk_index: child.index,
            heading: child.heading ?? null,
            path: child.path ?? null,
            page_number: pageNumber,
            content: child.content,
            context_prefix: child.contextPrefix ?? null,
            token_estimate: Math.max(1, child.tokenEstimate),
            embedding_status: "pending_embedding",
            metadata: {
              parent_index: child.parentIndex,
              child_index: child.index,
              page_start: pageNumber,
              page_end: pageNumber,
              extraction_status: page.extractionStatus,
            },
          }];
        });
        const childRows = await insertInBatches(
          args.userDb,
          childInputs,
          dependencies.insertChunks,
        );

        indexedPages += 1;
        canonicalCharacters += page.characterCount;
        estimatedSourceTokens += pageTokenEstimate;
        parentChunksCreated += parentRows.length;
        childChunksCreated += childRows.length;
        parentIndexOffset += pageChunks.parents.length;
        childIndexOffset += pageChunks.children.length;
      }

      if (processedPages % progressPageBatch === 0 || processedPages === args.source.pageCount) {
        await dependencies.updateDocumentProgress(
          args.userDb,
          document.id,
          args.ownerUserId,
          buildProgressMetadata({
            baseMetadata,
            source: args.source,
            processedPages,
            indexedPages,
            emptyPages,
            failedPages,
            parentChunks: parentChunksCreated,
            childChunks: childChunksCreated,
            canonicalCharacters,
            estimatedSourceTokens,
            tokenLimitExceeded,
            ingestionStatus: "processing",
          }),
        );
      }
    }

    if (indexedPages === 0 && failedPages.length === 0) {
      const metadata = buildProgressMetadata({
        baseMetadata,
        source: args.source,
        processedPages,
        indexedPages,
        emptyPages,
        failedPages,
        parentChunks: parentChunksCreated,
        childChunks: childChunksCreated,
        canonicalCharacters,
        estimatedSourceTokens,
        tokenLimitExceeded,
        ingestionStatus: "ocr_required",
      });
      await dependencies.updateDocumentStatus(
        args.userDb,
        document.id,
        args.ownerUserId,
        "failed",
        metadata,
      );
      return {
        status: "persisted",
        document: { ...document, status: "failed", metadata },
        parentChunksCreated,
        childChunksCreated,
        reason: "ocr_required",
      };
    }

    const partial = args.source.pageLimitExceeded || tokenLimitExceeded || failedPages.length > 0;
    const ingestionStatus = partial ? "partial" : "ready";
    const metadata = {
      ...buildProgressMetadata({
        baseMetadata,
        source: args.source,
        processedPages,
        indexedPages,
        emptyPages,
        failedPages,
        parentChunks: parentChunksCreated,
        childChunks: childChunksCreated,
        canonicalCharacters,
        estimatedSourceTokens,
        tokenLimitExceeded,
        ingestionStatus,
      }),
      completed_at: new Date().toISOString(),
    };
    await dependencies.updateDocumentStatus(
      args.userDb,
      document.id,
      args.ownerUserId,
      "ready",
      metadata,
    );
    return {
      status: "persisted",
      document: { ...document, status: "ready", metadata },
      parentChunksCreated,
      childChunksCreated,
      reason: partial ? "partial" : undefined,
    };
  } catch (error) {
    const metadata = {
      ...buildProgressMetadata({
        baseMetadata,
        source: args.source,
        processedPages,
        indexedPages,
        emptyPages,
        failedPages,
        parentChunks: parentChunksCreated,
        childChunks: childChunksCreated,
        canonicalCharacters,
        estimatedSourceTokens,
        tokenLimitExceeded,
        ingestionStatus: "failed",
      }),
      failure_type: error instanceof Error ? error.name : "unknown",
      failed_at: new Date().toISOString(),
    };
    await dependencies.updateDocumentStatus(
      args.userDb,
      document.id,
      args.ownerUserId,
      "failed",
      metadata,
    ).catch(() => undefined);
    throw error;
  } finally {
    await args.source.destroy().catch(() => undefined);
  }
}
