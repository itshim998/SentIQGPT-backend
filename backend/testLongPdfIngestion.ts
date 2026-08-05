import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  clearPendingPdfCanonicalSourcesForTests,
  getPendingPdfCanonicalSourceCountForTests,
  registerPendingPdfCanonicalSource,
  type ExtractedPdfPage,
  type PendingPdfCanonicalSource,
} from "./ai/pdfCanonicalSourceRegistry";
import {
  SourceRetrievalService,
  type SourceChunkIdentity,
  type SourceChunkInsert,
  type SourceDocumentRow,
} from "./services/sourceRetrievalService";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000003";
const ANALYSIS_ID = "00000000-0000-4000-8000-000000000004";
const userDb = { test: true };

function makePage(
  pageNumber: number,
  extractionStatus: ExtractedPdfPage["extractionStatus"],
  text = "",
): ExtractedPdfPage {
  return {
    pageNumber,
    text,
    characterCount: text.length,
    extractionStatus,
    errorType: extractionStatus === "failed" ? "SyntheticPageError" : undefined,
  };
}

function makePendingSource(args: {
  previewText: string;
  pages: readonly ExtractedPdfPage[];
  contentHash?: string;
  declaredPageCount?: number;
  pageLimitExceeded?: boolean;
  onDestroy?: () => void;
}): PendingPdfCanonicalSource {
  const byPage = new Map(args.pages.map((page) => [page.pageNumber, page]));
  const pageCount = args.pages.length;
  return {
    ownerUserId: USER_ID,
    filename: "long-report.pdf",
    sizeBytes: 9_000_000,
    previewText: args.previewText,
    contentHash: args.contentHash ?? "b".repeat(64),
    declaredPageCount: args.declaredPageCount ?? pageCount,
    pageCount,
    pageLimitExceeded: args.pageLimitExceeded ?? false,
    readPage: async (pageNumber) => byPage.get(pageNumber) ?? makePage(pageNumber, "failed"),
    destroy: async () => {
      args.onDestroy?.();
    },
  };
}

function processingDocument(input: {
  content_hash: string;
  metadata: Record<string, unknown>;
}): SourceDocumentRow {
  return {
    id: DOCUMENT_ID,
    owner_user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    title: "long-report.pdf",
    original_filename: "long-report.pdf",
    mime_type: "application/pdf",
    source_type: "pdf",
    content_hash: input.content_hash,
    status: "processing",
    metadata: input.metadata,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function testIncrementalPagePersistence(): Promise<void> {
  await clearPendingPdfCanonicalSourcesForTests();
  const previewText = "[Page 1]\nBounded browser preview.";
  const pageOne = Array.from({ length: 1_500 }, (_, index) => `alpha${index}`).join(" ");
  const pageFour = Array.from({ length: 1_200 }, (_, index) => `omega${index}`).join(" ");
  let destroyCount = 0;
  registerPendingPdfCanonicalSource(makePendingSource({
    previewText,
    pages: [
      makePage(1, "text", pageOne),
      makePage(2, "empty"),
      makePage(3, "failed"),
      makePage(4, "text", pageFour),
    ],
    onDestroy: () => { destroyCount += 1; },
  }));

  const insertedBatches: SourceChunkInsert[][] = [];
  const progressUpdates: Record<string, unknown>[] = [];
  const statusUpdates: Array<{ status: string; metadata: Record<string, unknown> }> = [];
  let insertedDocumentInput: Record<string, unknown> | undefined;
  let identityCounter = 0;
  const service = new SourceRetrievalService({
    findExistingDocuments: async () => [],
    deleteDocument: async () => undefined,
    insertDocument: async (_db, input) => {
      insertedDocumentInput = input as unknown as Record<string, unknown>;
      return processingDocument({ content_hash: input.content_hash, metadata: input.metadata });
    },
    insertChunks: async (_db, rows) => {
      insertedBatches.push([...rows]);
      return rows.map((row): SourceChunkIdentity => ({
        id: `chunk-${identityCounter++}`,
        chunk_index: row.chunk_index,
        chunk_role: row.chunk_role,
      }));
    },
    updateDocumentProgress: async (_db, _documentId, _ownerUserId, metadata) => {
      progressUpdates.push(metadata);
    },
    updateDocumentStatus: async (_db, _documentId, _ownerUserId, status, metadata) => {
      statusUpdates.push({ status, metadata });
    },
  });

  const result = await service.persistUploadedSource({
    userDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    filename: "long-report.pdf",
    mimeType: "application/pdf",
    extractionType: "pdf",
    extractedText: previewText,
    sizeBytes: 9_000_000,
    analysisId: ANALYSIS_ID,
  });

  assert.equal(result.status, "persisted");
  assert.equal(result.document?.status, "ready");
  assert.equal(result.reason, "partial", "one failed page produces an explicitly partial index");
  assert.equal(insertedDocumentInput?.content_hash, "b".repeat(64), "canonical file hash, not preview hash, is persisted");
  assert.equal(insertedDocumentInput?.status, "processing");
  assert(insertedBatches.length >= 4, "parents and children are inserted incrementally per text page");
  const rows = insertedBatches.flat();
  assert(rows.some((row) => row.chunk_role === "parent" && row.page_number === 1));
  assert(rows.some((row) => row.chunk_role === "child" && row.page_number === 1));
  assert(rows.some((row) => row.chunk_role === "parent" && row.page_number === 4));
  assert(rows.some((row) => row.chunk_role === "child" && row.page_number === 4));
  assert(rows.every((row) => row.page_number === 1 || row.page_number === 4));
  assert(rows.every((row) => typeof row.metadata.page_start === "number"));
  assert(progressUpdates.length >= 1, "processing metadata is checkpointed during ingestion");
  assert.equal(statusUpdates.at(-1)?.status, "ready");
  assert.equal(statusUpdates.at(-1)?.metadata.ingestion_status, "partial");
  assert.equal(statusUpdates.at(-1)?.metadata.indexed_page_count, 2);
  assert.equal(statusUpdates.at(-1)?.metadata.empty_page_count, 1);
  assert.equal(statusUpdates.at(-1)?.metadata.failed_page_count, 1);
  assert.deepEqual(statusUpdates.at(-1)?.metadata.failed_pages, [3]);
  assert.equal(destroyCount, 1, "parser is destroyed after persistence");
  assert.equal(getPendingPdfCanonicalSourceCountForTests(), 0, "canonical parser handle is consumed exactly once");
}

async function testScannedPdfClassification(): Promise<void> {
  await clearPendingPdfCanonicalSourcesForTests();
  const previewText = "[This PDF appears to be scanned or image-based.]";
  let destroyCount = 0;
  registerPendingPdfCanonicalSource(makePendingSource({
    previewText,
    pages: [makePage(1, "empty"), makePage(2, "empty"), makePage(3, "empty")],
    onDestroy: () => { destroyCount += 1; },
  }));

  const statuses: Array<{ status: string; metadata: Record<string, unknown> }> = [];
  const service = new SourceRetrievalService({
    findExistingDocuments: async () => [],
    deleteDocument: async () => undefined,
    insertDocument: async (_db, input) => processingDocument({
      content_hash: input.content_hash,
      metadata: input.metadata,
    }),
    insertChunks: async () => [],
    updateDocumentProgress: async () => undefined,
    updateDocumentStatus: async (_db, _documentId, _ownerUserId, status, metadata) => {
      statuses.push({ status, metadata });
    },
  });
  const result = await service.persistUploadedSource({
    userDb,
    ownerUserId: USER_ID,
    filename: "long-report.pdf",
    mimeType: "application/pdf",
    extractionType: "pdf",
    extractedText: previewText,
    sizeBytes: 9_000_000,
  });
  assert.equal(result.reason, "ocr_required");
  assert.equal(result.document?.status, "failed");
  assert.equal(statuses.at(-1)?.status, "failed");
  assert.equal(statuses.at(-1)?.metadata.ingestion_status, "ocr_required");
  assert.equal(statuses.at(-1)?.metadata.ocr_required, true);
  assert.equal(destroyCount, 1);
}

async function testContentHashReuseDestroysParser(): Promise<void> {
  await clearPendingPdfCanonicalSourcesForTests();
  const previewText = "[Page 1]\nReusable preview";
  let destroyCount = 0;
  registerPendingPdfCanonicalSource(makePendingSource({
    previewText,
    pages: [makePage(1, "text", "Reusable canonical content ".repeat(100))],
    onDestroy: () => { destroyCount += 1; },
  }));
  const ready: SourceDocumentRow = {
    ...processingDocument({ content_hash: "b".repeat(64), metadata: {
      parent_chunk_count: 2,
      child_chunk_count: 5,
      ingestion_status: "ready",
    } }),
    status: "ready",
  };
  let insertCount = 0;
  const service = new SourceRetrievalService({
    findExistingDocuments: async () => [ready],
    insertDocument: async () => {
      insertCount += 1;
      return ready;
    },
  });
  const result = await service.persistUploadedSource({
    userDb,
    ownerUserId: USER_ID,
    filename: "long-report.pdf",
    mimeType: "application/pdf",
    extractionType: "pdf",
    extractedText: previewText,
    sizeBytes: 9_000_000,
  });
  assert.equal(result.reason, "content_hash_reused");
  assert.equal(result.parentChunksCreated, 2);
  assert.equal(result.childChunksCreated, 5);
  assert.equal(insertCount, 0);
  assert.equal(destroyCount, 1, "reused uploads still release the parser handle");
}

async function testStaticContracts(): Promise<void> {
  const handler = await readFile(path.resolve("backend/ai/FileIngestionHandler.ts"), "utf8");
  assert(!handler.includes("MAX_PDF_CHARS"), "canonical PDF truncation constant is removed");
  assert.match(handler, /getText\(\{ partial: \[boundedPageNumber\] \}\)/);
  assert.match(handler, /registerPendingPdfCanonicalSource/);
  assert.match(handler, /SENTIQ_PDF_PREVIEW_CHARS/);
  assert.match(handler, /SENTIQ_PDF_MAX_PAGES/);

  const service = await readFile(path.resolve("backend/services/longPdfPersistenceService.ts"), "utf8");
  assert.match(service, /page_number: pageNumber/);
  assert.match(service, /ingestion_status/);
  assert.match(service, /ocr_required/);
  assert.match(service, /SENTIQ_PDF_MAX_STORED_TOKENS/);
  assert.match(service, /content_hash_reused/);

  const migration = await readFile(
    path.resolve("supabase/migrations/20260805043000_harden_long_pdf_ingestion.sql"),
    "utf8",
  );
  assert.match(migration, /Database 2, 3, 4 only/i);
  assert.match(migration, /source_documents_owner_hash_status_updated_idx/i);
  assert.match(migration, /source_chunks_document_page_role_idx/i);
}

async function main(): Promise<void> {
  await testIncrementalPagePersistence();
  await testScannedPdfClassification();
  await testContentHashReuseDestroysParser();
  await testStaticContracts();
  await clearPendingPdfCanonicalSourcesForTests();
  console.log("Long PDF ingestion Phase 4 tests passed.");
}

main().catch(async (error) => {
  await clearPendingPdfCanonicalSourcesForTests();
  console.error(error);
  process.exitCode = 1;
});
