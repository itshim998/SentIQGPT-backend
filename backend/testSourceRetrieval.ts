import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chunkSourceText } from "./context/sourceChunker";
import { composeContextDetailed } from "./orchestrator/contextComposer";
import { ChatRequestSchema } from "./validation/schemas";
import {
  SourceRetrievalService,
  scoreSourceChunkLexical,
  type SourceChunkHit,
  type SourceChunkInsert,
  type SourceChunkIdentity,
  type SourceDocumentRow,
} from "./services/sourceRetrievalService";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000003";
const ANALYSIS_ID = "00000000-0000-4000-8000-000000000004";
const userDb = { test: true };

function document(overrides: Partial<SourceDocumentRow> = {}): SourceDocumentRow {
  return {
    id: DOCUMENT_ID,
    owner_user_id: USER_ID,
    conversation_id: null,
    title: "quarterly-report.txt",
    original_filename: "quarterly-report.txt",
    mime_type: "text/plain",
    source_type: "text",
    content_hash: "a".repeat(64),
    status: "ready",
    metadata: { analysis_id: ANALYSIS_ID },
    referenceIndexes: [0],
    ...overrides,
  };
}

function hit(overrides: Partial<SourceChunkHit> = {}): SourceChunkHit {
  return {
    chunkId: "child-1",
    documentId: DOCUMENT_ID,
    parentChunkId: "parent-1",
    title: "quarterly-report.txt",
    chunkIndex: 0,
    content: "Quarterly margin improved to 42 percent.",
    contextPrefix: "quarterly-report.txt > Results",
    parentContent: "Results show stronger revenue and the quarterly margin improved to 42 percent after operating changes.",
    parentContextPrefix: "quarterly-report.txt > Results",
    heading: "Results",
    relevance: 1,
    ...overrides,
  };
}

async function testMigrationShape(): Promise<void> {
  const sql = await readFile(path.resolve("supabase/migrations/20260702160000_add_source_document_retrieval.sql"), "utf8");
  assert.match(sql, /Database 2, 3, 4 only/i);
  assert.match(sql, /create table if not exists public\.source_documents/i);
  assert.match(sql, /create table if not exists public\.source_chunks/i);
  for (const column of [
    "owner_user_id", "conversation_id", "content_hash", "parent_chunk_id", "chunk_role",
    "chunk_index", "context_prefix", "token_estimate", "embedding_status", "fts", "metadata",
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"), `migration includes ${column}`);
  }
  assert.match(sql, /to_tsvector\('simple'/i);
  assert.match(sql, /source_chunks_fts_idx[\s\S]*using gin\(fts\)/i);
  assert.match(sql, /create or replace function public\.search_source_chunks/i);
  assert.match(sql, /alter table public\.source_documents enable row level security/i);
  assert.match(sql, /alter table public\.source_chunks enable row level security/i);
  assert.match(sql, /owner_user_id = auth\.uid\(\)/i);
  assert(!/\bvector\s*\(/i.test(sql), "migration does not assume pgvector dimensions");

  const verifier = await readFile(path.resolve("backend/dbRouter.ts"), "utf8");
  assert(verifier.includes('from("source_documents")'));
  assert(verifier.includes('from("source_chunks")'));
  assert(verifier.includes('rpc("search_source_chunks"'));
}

function testParentChildChunking(): void {
  const text = Array.from({ length: 5_000 }, (_, index) => `sourceword${index}`).join(" ");
  const chunks = chunkSourceText({ text, title: "large-source.txt", path: "large-source.txt" });
  assert(chunks.parents.length > 2, "large sources create multiple parent chunks");
  assert(chunks.children.length > chunks.parents.length, "each parent is split into smaller children");
  for (const parent of chunks.parents.slice(0, -1)) {
    assert(parent.tokenEstimate >= 900 && parent.tokenEstimate <= 1_400, `parent token range: ${parent.tokenEstimate}`);
  }
  for (const child of chunks.children.filter((item) => {
    const siblings = chunks.children.filter((candidate) => candidate.parentIndex === item.parentIndex);
    return item.index !== siblings[siblings.length - 1]?.index;
  })) {
    assert(child.tokenEstimate >= 250 && child.tokenEstimate <= 450, `child token range: ${child.tokenEstimate}`);
  }
  const siblings = chunks.children.filter((child) => child.parentIndex === 0);
  assert(siblings.length > 1);
  const overlapWords = siblings[0].content.split(/\s+/).slice(-8).join(" ");
  assert(siblings[1].content.includes(overlapWords), "adjacent child chunks retain overlap");
  assert(chunks.children.every((child) => chunks.parents.some((parent) => parent.index === child.parentIndex)));
}

async function testPersistenceAndGuestGuard(): Promise<void> {
  let documentInsertCount = 0;
  const insertedChunkBatches: SourceChunkInsert[][] = [];
  const statusUpdates: string[] = [];
  const service = new SourceRetrievalService({
    insertDocument: async (_db, input) => {
      documentInsertCount += 1;
      return document({
        owner_user_id: input.owner_user_id,
        conversation_id: input.conversation_id,
        title: input.title,
        original_filename: input.original_filename,
        mime_type: input.mime_type,
        source_type: input.source_type,
        content_hash: input.content_hash,
        status: input.status,
        metadata: input.metadata,
      });
    },
    insertChunks: async (_db, rows) => {
      insertedChunkBatches.push([...rows]);
      return rows.map((row, index): SourceChunkIdentity => ({
        id: `${row.chunk_role}-${insertedChunkBatches.length}-${index}`,
        chunk_index: row.chunk_index,
        chunk_role: row.chunk_role,
      }));
    },
    updateDocumentStatus: async (_db, _documentId, _ownerUserId, status) => {
      statusUpdates.push(status);
    },
  });
  const persisted = await service.persistUploadedSource({
    userDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    filename: "sample.ts",
    mimeType: "text/typescript",
    extractionType: "txt",
    extractedText: Array.from({ length: 2_000 }, (_, index) => `const value${index} = ${index};`).join("\n"),
    sizeBytes: 50_000,
    analysisId: ANALYSIS_ID,
  });
  assert.equal(persisted.status, "persisted");
  assert.equal(persisted.document?.source_type, "code");
  assert.equal(persisted.document?.content_hash.length, 64);
  assert(insertedChunkBatches[0].every((row) => row.chunk_role === "parent" && row.parent_chunk_id === null));
  assert(insertedChunkBatches[1].every((row) => row.chunk_role === "child" && Boolean(row.parent_chunk_id)));
  assert(insertedChunkBatches.flat().every((row) => row.embedding_status === "pending_embedding"));
  assert.deepEqual(statusUpdates, ["ready"]);

  const guest = await service.persistUploadedSource({
    userDb,
    ownerUserId: "guest",
    filename: "guest.txt",
    mimeType: "text/plain",
    extractionType: "txt",
    extractedText: "Guest text remains ephemeral.",
    sizeBytes: 30,
  });
  assert.equal(guest.status, "skipped");
  assert.equal(documentInsertCount, 1, "guest upload never reaches persistence dependencies");
}

async function testRetrievalAndLegacyFallback(): Promise<void> {
  const lexicalHits = [
    hit(),
    hit({ chunkId: "child-2", chunkIndex: 1, content: "The operating changes reduced costs.", relevance: 0.5 }),
  ];
  const service = new SourceRetrievalService({
    resolveDocuments: async () => [document()],
    lexicalSearch: async () => lexicalHits,
  });
  const rawText = "LEGACY WHOLE FILE " + "unneeded ".repeat(3_000);
  const retrieved = await service.retrieveForPrompt({
    userDb,
    ownerUserId: USER_ID,
    query: "What was the quarterly margin?",
    fileReferences: [{ filename: "quarterly-report.txt", extractedText: rawText, analysis_id: ANALYSIS_ID }],
  });
  assert.equal(retrieved.mode, "lexical", "semantic-unavailable path remains lexical");
  assert.equal(retrieved.fileReferences.length, 1, "children sharing a parent are deduplicated into one source block");
  assert.equal(retrieved.fileReferences[0].retrieved, true);
  assert(retrieved.fileReferences[0].extractedText.includes("42 percent"));
  assert(!retrieved.fileReferences[0].extractedText.includes("LEGACY WHOLE FILE"), "persisted retrieval replaces wholesale raw text");

  const legacyService = new SourceRetrievalService({ resolveDocuments: async () => [] });
  const legacy = await legacyService.retrieveForPrompt({
    userDb,
    ownerUserId: USER_ID,
    query: "Summarize this",
    fileReferences: [{ filename: "legacy.txt", extractedText: "LEGACY FALLBACK MARKER" }],
  });
  assert.equal(legacy.mode, "legacy");
  assert.equal(legacy.fileReferences[0].extractedText, "LEGACY FALLBACK MARKER");

  const guest = await service.retrieveForPrompt({
    userDb,
    ownerUserId: "guest",
    query: "Summarize this",
    fileReferences: [{ filename: "guest.txt", extractedText: "GUEST FALLBACK MARKER", analysis_id: ANALYSIS_ID }],
  });
  assert.equal(guest.mode, "legacy");
  assert.equal(guest.fileReferences[0].extractedText, "GUEST FALLBACK MARKER");

  assert(
    scoreSourceChunkLexical("quarterly margin was 42 percent", "Results", "quarterly margin") >
      scoreSourceChunkLexical("employee directory", "Appendix", "quarterly margin"),
    "fallback lexical ranking favors query overlap",
  );
}

async function testOptionalHybridPath(): Promise<void> {
  const service = new SourceRetrievalService({
    resolveDocuments: async () => [document()],
    lexicalSearch: async () => [hit()],
    semanticSearch: async () => [hit({ chunkId: "semantic-child", parentChunkId: "semantic-parent", content: "Semantically related forecast.", relevance: 0.8 })],
  });
  const result = await service.retrieveForPrompt({
    userDb,
    ownerUserId: USER_ID,
    query: "forecast outlook",
    fileReferences: [{ filename: "quarterly-report.txt", extractedText: "raw", sourceDocumentId: DOCUMENT_ID }],
  });
  assert.equal(result.mode, "hybrid");
}

function testContextBudgetIntegration(): void {
  const composed = composeContextDetailed({
    systemPrompt: "SYSTEM",
    workspaceCapsule: "WORKSPACE CAPSULE MARKER",
    conversationCapsule: "CONVERSATION CAPSULE MARKER",
    memories: [{ type: "preference", summary: "MEMORY MARKER: use concise bullets", relevance: 1 }],
    fileReferences: [{
      filename: "quarterly-report.txt",
      extractedText: "PARENT EXCERPT:\nResults and context.\nMATCHED EXCERPT:\nQuarterly margin was 42 percent.",
      retrieved: true,
      relevance: 1,
      sourceChunkCount: 1,
    }],
    conversation: [{ role: "assistant", content: "RECENT TURN MARKER" }],
    userMessage: "CURRENT QUESTION MARKER",
    tokenBudget: 1_400,
  });
  assert(composed.prompt.includes("RETRIEVED SOURCE: quarterly-report.txt"));
  assert(composed.prompt.includes("42 percent"));
  assert(composed.prompt.includes("MEMORY MARKER"));
  assert(composed.prompt.includes("WORKSPACE CAPSULE MARKER"));
  assert(composed.prompt.includes("CONVERSATION CAPSULE MARKER"));
  assert(composed.prompt.trimEnd().endsWith("CURRENT QUESTION MARKER"));

  const oversizedRetrieved = composeContextDetailed({
    systemPrompt: "SYSTEM",
    fileReferences: [{
      filename: "large-retrieved.txt",
      extractedText: Array.from({ length: 5_000 }, (_, index) => `retrieved-${index}`).join(" "),
      retrieved: true,
      relevance: 1,
      sourceChunkCount: 8,
    }],
    userMessage: "PROTECTED LARGE SOURCE QUESTION",
    tokenBudget: 350,
  });
  assert(oversizedRetrieved.telemetry.droppedCounts.file_chunks > 0, "retrieved source blocks trim under context pressure");
  assert(oversizedRetrieved.prompt.includes("PROTECTED LARGE SOURCE QUESTION"));
  assert(oversizedRetrieved.prompt.trimEnd().endsWith("PROTECTED LARGE SOURCE QUESTION"));
}

async function testUploadAndValidationIntegration(): Promise<void> {
  const parsed = ChatRequestSchema.parse({
    message: "Use the uploaded source",
    context: {
      file_references: [{ filename: "source.txt", source_document_id: DOCUMENT_ID }],
    },
  });
  assert.equal(parsed.context?.file_references?.[0].sourceDocumentId, DOCUMENT_ID);
  assert.equal(parsed.context?.file_references?.[0].extractedText, "");

  const serverPath = path.resolve(existsSync("backend/serverLegacy.ts") ? "backend/serverLegacy.ts" : "backend/server.ts");
  const server = await readFile(serverPath, "utf8");
  const uploadStart = server.indexOf('"/api/files/upload"');
  const uploadEnd = server.indexOf('"/api/files/session"', uploadStart);
  const uploadRoute = server.slice(uploadStart, uploadEnd);
  assert(uploadRoute.includes("sourceRetrievalService.persistUploadedSource"));
  assert(uploadRoute.includes('if (!isGuest && (result.type === "pdf" || result.type === "txt"))'));
  assert(uploadRoute.includes("document_id: persistedSource?.document?.id"));
  assert(uploadRoute.includes("source_document_id: persistedSource?.document?.id"));
}

async function main(): Promise<void> {
  await testMigrationShape();
  testParentChildChunking();
  await testPersistenceAndGuestGuard();
  await testRetrievalAndLegacyFallback();
  await testOptionalHybridPath();
  testContextBudgetIntegration();
  await testUploadAndValidationIntegration();
  console.log("Source retrieval Phase 4 tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
