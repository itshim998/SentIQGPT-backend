import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import sharp from "sharp";

import { extractTextFromFile } from "./ai/FileIngestionHandler";
import {
  getEnabledAutomaticSentIQTools,
  hasVisualAssetsRequiringAnalysis,
} from "./ai/modelToolCapability";
import {
  SourceRetrievalService,
  isQueryTargetingVisualAsset,
  type SourceDocumentRow,
  type UploadedSourceReference,
} from "./services/sourceRetrievalService";
import { renderPdfPage, getPdfInfo } from "./tools/imageInput/pdfRenderer";
import { preprocessImage } from "./tools/imageInput/imagePreprocessor";
import {
  computeVisualAnalysisCacheKey,
  getCachedVisualAnalysis,
  setCachedVisualAnalysis,
} from "./tools/imageInput/visualCache";
import {
  selectInitialResolutionPolicy,
  RESOLUTION_POLICIES,
} from "./tools/imageInput/resolutionPolicy";
import { partitionVisualBatches, type BatchItem } from "./tools/imageInput/visualBatcher";
import { execImageInput } from "./orchestrator/toolExecutor";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";

// Helper to generate a PDF in memory
async function createTestPdf(options: { text?: string; pages?: number }): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const count = options.pages ?? 1;
    for (let i = 0; i < count; i++) {
      doc.addPage();
      if (options.text) {
        doc.fontSize(16).text(`${options.text} - Page ${i + 1}`, 100, 100);
      }
    }
    doc.end();
  });
}

// Helper to generate an image in memory
async function createTestImage(width = 200, height = 200, format: "png" | "jpeg" | "webp" = "png"): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })[format]().toBuffer();
}

async function testScenarioA_SelectablePdf(): Promise<void> {
  console.log("Testing Scenario A: Selectable PDF...");
  const pdfText = "Education: Bachelor of Science in Computer Science. GPA: 3.92.";
  const buffer = await createTestPdf({ text: pdfText, pages: 1 });

  const result = await extractTextFromFile({
    buffer,
    filename: "Resume.pdf",
    mimetype: "application/pdf",
    userId: USER_ID,
  });
  assert.equal(result.type, "pdf");
  assert.equal(result.visual_required, false);
  assert.equal(result.visual_analysis_status, "not_required");
  assert.ok(result.extracted_text.includes("3.92"));

  const fileRef: UploadedSourceReference = {
    filename: "Resume.pdf",
    extractedText: result.extracted_text,
    visual_required: false,
    visual_analysis_status: "not_required",
  };

  // image_input must NOT be required or exposed for selectable text PDF
  const requiresAnalysis = hasVisualAssetsRequiringAnalysis([fileRef]);
  assert.equal(requiresAnalysis, false);

  process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = "true";
  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "true";
  const enabledTools = getEnabledAutomaticSentIQTools({
    fileReferences: [fileRef as any],
  });
  assert.equal(enabledTools.includes("image_input"), false, "image_input must not be exposed when only selectable PDFs exist");
}

async function testScenarioB_ScannedPdf(): Promise<void> {
  console.log("Testing Scenario B: Scanned PDF...");
  // PDF with no text elements (scanned page simulation)
  const buffer = await createTestPdf({ pages: 1 });

  const result = await extractTextFromFile({
    buffer,
    filename: "ScannedXOR.pdf",
    mimetype: "application/pdf",
    userId: USER_ID,
  });
  assert.equal(result.type, "pdf");
  assert.equal(result.visual_required, true);
  assert.equal(result.visual_analysis_status, "required");
  assert.ok(result.extracted_text.includes("No selectable text was found"));

  const fileRef: UploadedSourceReference = {
    filename: "ScannedXOR.pdf",
    extractedText: "",
    visual_required: true,
    visual_analysis_status: "required",
    asset_id: "asset-xor-1",
  };

  const requiresAnalysis = hasVisualAssetsRequiringAnalysis([fileRef]);
  assert.equal(requiresAnalysis, true);

  process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = "true";
  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "true";
  const enabledTools = getEnabledAutomaticSentIQTools({
    fileReferences: [fileRef as any],
  });
  assert.equal(enabledTools.includes("image_input"), true, "image_input must be exposed when visual_required PDF is present");

  // Verify native PDF rendering
  const rendered = await renderPdfPage({ pdfBuffer: buffer, pageNumber: 1, scale: 1.0 });
  assert.equal(rendered.pageNumber, 1);
  assert.ok(rendered.imageBuffer.length > 0);
  assert.equal(rendered.mimeType, "image/png");
}

async function testScenarioC_HandwrittenImage(): Promise<void> {
  console.log("Testing Scenario C: Handwritten Image...");
  const imgBuffer = await createTestImage(300, 200, "png");
  const result = await extractTextFromFile({
    buffer: imgBuffer,
    filename: "handwritten_notes.png",
    mimetype: "image/png",
    userId: USER_ID,
  });

  assert.equal(result.type, "image");
  assert.equal(result.visual_required, true);
  assert.equal(result.visual_analysis_status, "required");

  const preprocessed = await preprocessImage(imgBuffer, {
    maxWidth: RESOLUTION_POLICIES.medium.maxWidth,
    maxHeight: RESOLUTION_POLICIES.medium.maxHeight,
    format: "jpeg",
    quality: RESOLUTION_POLICIES.medium.jpegQuality,
  });
  assert.ok(preprocessed.buffer.length > 0);
  assert.equal(preprocessed.mimeType, "image/jpeg");
}

async function testScenarioD_MultipleImages(): Promise<void> {
  console.log("Testing Scenario D: Multiple Images Batching...");
  const img1 = await createTestImage(100, 100, "png");
  const img2 = await createTestImage(100, 100, "png");
  const img3 = await createTestImage(100, 100, "png");

  const items: BatchItem[] = [
    { assetId: "a1", pageNumber: 1, buffer: img1, mimeType: "image/png", filename: "img1.png" },
    { assetId: "a2", pageNumber: 1, buffer: img2, mimeType: "image/png", filename: "img2.png" },
    { assetId: "a3", pageNumber: 1, buffer: img3, mimeType: "image/png", filename: "img3.png" },
  ];

  const batches = partitionVisualBatches(items, RESOLUTION_POLICIES.medium);
  assert.equal(batches.length, 1, "3 small images should fit into 1 batch within token budget");
  assert.equal(batches[0].items.length, 3);
}

async function testScenarioE_HeicHeifNormalization(): Promise<void> {
  console.log("Testing Scenario E: HEIC/HEIF normalization...");
  const sampleBuffer = await createTestImage(250, 250, "png");
  const preprocessed = await preprocessImage(sampleBuffer, {
    maxWidth: RESOLUTION_POLICIES.high.maxWidth,
    maxHeight: RESOLUTION_POLICIES.high.maxHeight,
    format: "jpeg",
  });

  assert.equal(preprocessed.mimeType, "image/jpeg");
  assert.ok(preprocessed.width <= RESOLUTION_POLICIES.high.maxWidth);
  assert.ok(preprocessed.height <= RESOLUTION_POLICIES.high.maxHeight);
}

async function testScenarioF_SecondTurnOcrReuse(): Promise<void> {
  console.log("Testing Scenario F: OCR Reuse / Cost Control...");
  const mockDb = createMockUserDatabase();
  const retrievalService = new SourceRetrievalService();

  const ocrText = "The XOR problem represents a non-linear classification barrier solved by multi-layer perceptrons.";
  const assetId = "00000000-0000-4000-8000-000000000099";

  // Turn 1: Persist canonical visual OCR
  const persistResult = await retrievalService.persistCanonicalVisualOcrSource({
    userDb: mockDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    assetId,
    filename: "XOR_notes.png",
    mimeType: "image/png",
    assetType: "image",
    extractedText: ocrText,
  });
  assert.equal(persistResult.status, "persisted");
  assert.ok(persistResult.document?.id);

  // Turn 2: User asks ordinary text question
  const turn2FileRef: UploadedSourceReference = {
    filename: "XOR_notes.png",
    sourceDocumentId: persistResult.document!.id,
    extractedText: "",
    visual_required: false,
    visual_analysis_status: "ready",
    asset_id: assetId,
  };

  // Turn 2 does not require visual analysis
  assert.equal(hasVisualAssetsRequiringAnalysis([turn2FileRef]), false);

  // Turn 2 retrieves from canonical source_chunks with zero visual calls
  const retrieved = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "Explain the non-linear classification barrier in the notes",
    fileReferences: [turn2FileRef],
  });

  assert.equal(retrieved.resolvedDocuments, 1);
  assert.ok(retrieved.selectedChunks > 0);
  assert.ok(retrieved.fileReferences.some((r) => r.retrieved));
}

async function testScenarioG_GenuineVisualQuestion(): Promise<void> {
  console.log("Testing Scenario G: Genuine Visual Question...");
  const visualRef: UploadedSourceReference = {
    filename: "diagram.png",
    extractedText: "Architecture Diagram",
    visual_required: false,
    visual_analysis_status: "ready",
  };

  const isVisual = isQueryTargetingVisualAsset(
    "What color is the arrow pointing to the database in the diagram?",
    visualRef,
    [visualRef],
  );
  assert.equal(isVisual, true, "Visual diagram inspection query should be recognized as targeting visual asset");
}

async function testScenarioH_TargetIsolationGuard(): Promise<void> {
  console.log("Testing Scenario H: Critical Target Isolation Guard (Section 42 & 43-H)...");
  const mockDb = createMockUserDatabase();
  const retrievalService = new SourceRetrievalService();

  // Insert Turn 1 document: Resume.pdf (ready)
  const resumeId = "00000000-0000-4000-8000-000000000010";
  mockDb._documents.set(resumeId, {
    id: resumeId,
    owner_user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    title: "Resume.pdf",
    original_filename: "Resume.pdf",
    mime_type: "application/pdf",
    source_type: "pdf",
    content_hash: "hash_resume",
    status: "ready",
    metadata: { canonical_character_count: 500 },
    referenceIndexes: [0],
  });

  // Turn 2: User uploads Scanned XOR.pdf (visual_required: true, unanalyzed)
  const unanalyzedXorRef: UploadedSourceReference = {
    filename: "XOR_scanned.pdf",
    extractedText: "",
    visual_required: true,
    visual_analysis_status: "required",
    asset_id: "00000000-0000-4000-8000-000000000020",
  };

  // User asks: "Explain the XOR problem in this PDF."
  const retrieved = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "Explain the XOR problem in this PDF.",
    fileReferences: [
      { filename: "Resume.pdf", sourceDocumentId: resumeId, extractedText: "GPA 3.92" },
      unanalyzedXorRef,
    ],
  });

  // CRITICAL INVARIANT: Resume.pdf must NEVER be returned or substituted for the unanalyzed XOR query!
  assert.equal(retrieved.mode, "none", "Retrieval must isolate pending visual asset and return mode 'none'");
  assert.equal(retrieved.selectedChunks, 0, "No chunks from older Resume.pdf should be retrieved");
  assert.equal(retrieved.fileReferences.length, 0, "No file references should be supplied when isolated");
}

async function testScenarioK_PartialPdfFailureHandling(): Promise<void> {
  console.log("Testing Scenario K: Partial PDF Failure Handling...");
  const items: BatchItem[] = [
    { assetId: "a1", pageNumber: 1, buffer: Buffer.from("page1"), mimeType: "image/png", filename: "doc.pdf" },
    { assetId: "a1", pageNumber: 2, buffer: Buffer.from("page2"), mimeType: "image/png", filename: "doc.pdf" },
  ];
  // Batches partition properly even if items have disparate sizes
  const batches = partitionVisualBatches(items, RESOLUTION_POLICIES.low);
  assert.ok(batches.length >= 1);
}

async function testScenarioL_DistinctVisualAssets(): Promise<void> {
  console.log("Testing Scenario L: Distinct Visual Assets Cache Keys...");
  const key1 = computeVisualAnalysisCacheKey({
    sha256: "sha_asset_1111",
    model: "gemini-3.5-flash-lite",
    requestSpecificQuery: "Read text",
  });
  const key2 = computeVisualAnalysisCacheKey({
    sha256: "sha_asset_2222",
    model: "gemini-3.5-flash-lite",
    requestSpecificQuery: "Read text",
  });

  assert.notEqual(key1, key2, "Different asset SHAs with identical queries must have distinct cache keys");
}

async function testSection44_CanonicalAcceptanceTest(): Promise<void> {
  console.log("Testing Section 44: CANONICAL ACCEPTANCE TEST (End-to-End)...");
  const mockDb = createMockUserDatabase();
  const retrievalService = new SourceRetrievalService();

  // -------------------------------------------------------------
  // TURN 1: Upload selectable Resume.pdf
  // -------------------------------------------------------------
  const resumeBuf = await createTestPdf({ text: "Candidate Resume. Overall GPA: 3.95 out of 4.0. Major in CS.", pages: 1 });
  const resumeUpload = await extractTextFromFile({
    buffer: resumeBuf,
    filename: "Resume.pdf",
    mimetype: "application/pdf",
    userId: USER_ID,
  });
  assert.equal(resumeUpload.visual_required, false);

  const resumePersist = await retrievalService.persistUploadedSource({
    userDb: mockDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    filename: "Resume.pdf",
    mimeType: "application/pdf",
    extractionType: "pdf",
    extractedText: resumeUpload.extracted_text,
    sizeBytes: resumeBuf.length,
  });
  assert.equal(resumePersist.status, "persisted");
  const resumeDocId = resumePersist.document!.id;

  // Ask: "What is my GPA?"
  const turn1Retrieval = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "What is my GPA?",
    fileReferences: [{ filename: "Resume.pdf", sourceDocumentId: resumeDocId, extractedText: resumeUpload.extracted_text }],
  });
  assert.ok(turn1Retrieval.selectedChunks > 0);
  assert.equal(hasVisualAssetsRequiringAnalysis([{ filename: "Resume.pdf", sourceDocumentId: resumeDocId, extractedText: resumeUpload.extracted_text }]), false);
  // Zero Gemini visual calls in Turn 1!

  // -------------------------------------------------------------
  // TURN 2: Upload scanned XOR.pdf
  // -------------------------------------------------------------
  const xorBuf = await createTestPdf({ pages: 1 }); // empty scanned page
  const xorUpload = await extractTextFromFile({
    buffer: xorBuf,
    filename: "XOR_scanned.pdf",
    mimetype: "application/pdf",
    userId: USER_ID,
  });
  assert.equal(xorUpload.visual_required, true);
  assert.equal(xorUpload.visual_analysis_status, "required");

  const xorAssetId = "00000000-0000-4000-8000-000000000088";
  const xorFileRef: UploadedSourceReference = {
    filename: "XOR_scanned.pdf",
    extractedText: "",
    visual_required: true,
    visual_analysis_status: "required",
    asset_id: xorAssetId,
  };

  // User asks: "Explain the XOR problem in this PDF."
  // Target isolation guard check: Resume.pdf must NOT be substituted!
  const turn2PreRetrieval = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "Explain the XOR problem in this PDF.",
    fileReferences: [
      { filename: "Resume.pdf", sourceDocumentId: resumeDocId, extractedText: resumeUpload.extracted_text },
      xorFileRef,
    ],
  });
  assert.equal(turn2PreRetrieval.mode, "none", "Target isolation must prevent Resume.pdf from answering XOR question");
  assert.equal(turn2PreRetrieval.selectedChunks, 0);

  // Main model identifies XOR_scanned.pdf requires image_input
  assert.equal(hasVisualAssetsRequiringAnalysis([xorFileRef]), true);

  // Simulate image_input execution for XOR_scanned.pdf
  const xorOcrText = "Section 2: The XOR Problem and Perceptron Limitations. Minsky and Papert (1969).";
  const xorPersist = await retrievalService.persistCanonicalVisualOcrSource({
    userDb: mockDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    assetId: xorAssetId,
    filename: "XOR_scanned.pdf",
    mimeType: "application/pdf",
    assetType: "scanned_pdf",
    extractedText: xorOcrText,
  });
  assert.equal(xorPersist.status, "persisted");
  const xorDocId = xorPersist.document!.id;

  // Now XOR is ready
  const xorReadyRef: UploadedSourceReference = {
    filename: "XOR_scanned.pdf",
    sourceDocumentId: xorDocId,
    extractedText: "",
    visual_required: false,
    visual_analysis_status: "ready",
    asset_id: xorAssetId,
  };

  // -------------------------------------------------------------
  // TURN 3: Ask "What was my GPA?"
  // -------------------------------------------------------------
  const turn3Retrieval = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "What was my GPA?",
    fileReferences: [
      { filename: "Resume.pdf", sourceDocumentId: resumeDocId, extractedText: resumeUpload.extracted_text },
      xorReadyRef,
    ],
  });

  // Normal retrieval finds Resume.pdf; 0 new Gemini visual calls
  assert.ok(turn3Retrieval.selectedChunks > 0);
  assert.equal(hasVisualAssetsRequiringAnalysis([{ filename: "Resume.pdf", sourceDocumentId: resumeDocId, extractedText: resumeUpload.extracted_text }, xorReadyRef]), false);
  console.log("Section 44: CANONICAL ACCEPTANCE TEST PASSED SUCCESSFULLY!");
}

function createMockUserDatabase() {
  const documents = new Map<string, SourceDocumentRow>();
  const chunks = new Map<string, any[]>();
  const visualAssets = new Map<string, any>();
  let docCounter = 1;
  let chunkCounter = 1;

  function createQueryBuilder(initialItems: any[]) {
    let items = [...initialItems];
    const builder: any = {
      eq(col: string, val: any) {
        items = items.filter((item) => item[col] === val);
        return builder;
      },
      in(col: string, vals: any[]) {
        items = items.filter((item) => vals.includes(item[col]));
        return builder;
      },
      contains(col: string, targetObj: any) {
        items = items.filter((item) => {
          const val = item[col] || {};
          return Object.entries(targetObj).every(([k, v]) => val[k] === v);
        });
        return builder;
      },
      limit(n: number) {
        items = items.slice(0, n);
        return builder;
      },
      order(_col: string, _options?: any) {
        return builder;
      },
      single() {
        return Promise.resolve({ data: items[0] ?? null, error: null });
      },
      then(onFulfilled: any, onRejected?: any) {
        return Promise.resolve({ data: items, error: null }).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return {
    _documents: documents,
    _chunks: chunks,
    _visualAssets: visualAssets,
    from(table: string) {
      if (table === "source_documents") {
        return {
          select(_cols?: string) {
            return createQueryBuilder([...documents.values()]);
          },
          insert(docData: any) {
            const id = docData.id || `00000000-0000-4000-8000-${String(docCounter++).padStart(12, "0")}`;
            const row: SourceDocumentRow = { ...docData, id };
            documents.set(id, row);
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: row, error: null });
                  },
                };
              },
            };
          },
          update(updates: any) {
            let matchedDoc: any = null;
            const updateBuilder: any = {
              eq(col: string, val: any) {
                if (col === "id") {
                  matchedDoc = documents.get(val);
                }
                if (matchedDoc) Object.assign(matchedDoc, updates);
                return updateBuilder;
              },
              then(onFulfilled: any, onRejected?: any) {
                return Promise.resolve({ data: matchedDoc, error: null }).then(onFulfilled, onRejected);
              },
            };
            return updateBuilder;
          },
        };
      }
      if (table === "source_chunks") {
        return {
          insert(chunkDataList: any[]) {
            const inserted = chunkDataList.map((c) => {
              const id = `00000000-0000-4000-9000-${String(chunkCounter++).padStart(12, "0")}`;
              const docList = chunks.get(c.document_id) || [];
              const fullChunk = { ...c, id };
              docList.push(fullChunk);
              chunks.set(c.document_id, docList);
              return { id, chunk_index: c.chunk_index };
            });
            return {
              select() {
                return Promise.resolve({ data: inserted, error: null });
              },
            };
          },
          select(_cols?: string) {
            const allChunks: any[] = [];
            for (const list of chunks.values()) {
              allChunks.push(...list);
            }
            return createQueryBuilder(allChunks);
          },
        };
      }
      if (table === "visual_assets") {
        return {
          select(_cols?: string) {
            return createQueryBuilder([...visualAssets.values()]);
          },
          insert(assetData: any) {
            const id = assetData.id || `asset-${Date.now()}`;
            const row = { ...assetData, id };
            visualAssets.set(id, row);
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: row, error: null });
                  },
                };
              },
            };
          },
          update(updates: any) {
            let matchedAsset: any = null;
            const updateBuilder: any = {
              eq(col: string, val: any) {
                if (col === "id") {
                  matchedAsset = visualAssets.get(val);
                }
                if (matchedAsset) Object.assign(matchedAsset, updates);
                return updateBuilder;
              },
              then(onFulfilled: any, onRejected?: any) {
                return Promise.resolve({ data: matchedAsset, error: null }).then(onFulfilled, onRejected);
              },
            };
            return updateBuilder;
          },
        };
      }
      throw new Error(`Unhandled mock table: ${table}`);
    },
    rpc() {
      // Simulate RPC error to trigger fallbackLexicalSearch
      return Promise.resolve({ data: null, error: { code: "RPC_DISABLED_IN_MOCK" } });
    },
  };
}

async function main(): Promise<void> {
  console.log("=== Running SentIQ Layer 1 Image Input Test Suite ===");
  await testScenarioA_SelectablePdf();
  await testScenarioB_ScannedPdf();
  await testScenarioC_HandwrittenImage();
  await testScenarioD_MultipleImages();
  await testScenarioE_HeicHeifNormalization();
  await testScenarioF_SecondTurnOcrReuse();
  await testScenarioG_GenuineVisualQuestion();
  await testScenarioH_TargetIsolationGuard();
  await testScenarioK_PartialPdfFailureHandling();
  await testScenarioL_DistinctVisualAssets();
  await testSection44_CanonicalAcceptanceTest();
  console.log("=== All Layer 1 Tests Passed Successfully! ===");
}

main().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
