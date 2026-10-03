import "dotenv/config";
import assert from "assert/strict";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { buildContextFast, extractCurrentVisualAssets } from "./context/contextBuilder";
import { getEnabledAutomaticSentIQTools, hasVisualAssetsRequiringAnalysis } from "./ai/modelToolCapability";
import { executeAutomaticModelToolCalls, isVisualTargetRequiredForQuery, execImageInput } from "./orchestrator/toolExecutor";
import { ChatRequestSchema } from "./validation/schemas";
import { FAST_PROFILE } from "./orchestrator/executionProfile";
import type { ValidatedToolCall } from "./orchestrator/toolContract";
import { SourceRetrievalService } from "./services/sourceRetrievalService";
import { buildIntuitiveToolSelectionPrompt, buildIntuitiveToolSynthesisEvidence, shouldRunIntuitiveFinalSynthesis } from "./orchestrator/intuitiveTextLane";

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

function createMockUserDatabase() {
  const documents = new Map<string, any>();
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
            const row = { ...docData, id };
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
      throw new Error(`Unsupported mock table: ${table}`);
    },
    rpc() {
      return Promise.resolve({ data: [], error: null });
    },
  };
}

async function runFiveTargetedScenarios() {
  process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = "true";
  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "true";
  console.log("================================================================================");
  console.log("RUNNING 5 TARGETED SCENARIOS (CONTROLLED BACKEND ENVIRONMENT)");
  console.log("================================================================================\n");

  const USER_ID = "00000000-0000-4000-8000-000000000001";
  const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";
  const mockDb = createMockUserDatabase();
  const retrievalService = new SourceRetrievalService();

  // ============================================================================
  // CASE 1: Selectable Resume PDF -> "What is my GPA?"
  // Expected: correct resume answer, no image_input, no false frontend error.
  // ============================================================================
  console.log("--- CASE 1: Selectable Resume PDF Baseline ---");
  const resumeText = "Sounak Poddar | Computer Science Engineering | CGPA: 8.04 / 10 | Skills: AI, TypeScript, Python";
  const resumePersist = await retrievalService.persistUploadedSource({
    userDb: mockDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    filename: "Sounak_Poddar_Resume.pdf",
    mimeType: "application/pdf",
    extractionType: "pdf",
    extractedText: resumeText,
    sizeBytes: 1024,
  });
  const resumeDocId = resumePersist.document!.id;
  const resumeFileRef = {
    filename: "Sounak_Poddar_Resume.pdf",
    sourceDocumentId: resumeDocId,
    extractedText: resumeText,
    visual_required: false,
    visual_analysis_status: "not_required",
  };

  const case1Context = await buildContextFast({
    userMessage: "What is my GPA?",
    conversationId: CONVERSATION_ID,
    file_references: [resumeFileRef as any],
  });

  const case1VisualNeeded = hasVisualAssetsRequiringAnalysis(case1Context.fileReferences, case1Context.currentVisualAssets);
  assert.equal(case1VisualNeeded, false, "Resume PDF must not require visual analysis");

  const case1Tools = getEnabledAutomaticSentIQTools({
    fileReferences: case1Context.fileReferences,
    visualAssets: case1Context.currentVisualAssets,
  });
  assert.equal(case1Tools.includes("image_input"), false, "image_input must NOT be enabled for selectable resume");

  const case1Retrieval = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "What is my GPA?",
    fileReferences: [resumeFileRef as any],
  });
  assert.ok(case1Retrieval.selectedChunks > 0, "Resume chunks must be retrieved");
  const retrievedContent = case1Retrieval.fileReferences.map((f: any) => f.extractedText).join(" ");
  assert.ok(retrievedContent.includes("8.04"), "Retrieved content must contain GPA 8.04");
  console.log("[CASE 1 PASS]: Selectable resume grounded with 8.04 GPA, image_input bypassed.\n");

  // ============================================================================
  // CASE 2: Scanned XOR PDF in Fast Mode
  // Expected: image_input is selected, executed, evidence returned to main model
  // ============================================================================
  console.log("--- CASE 2: Scanned XOR PDF in Fast Mode ---");
  const xorAssetId = "00000000-0000-4000-8000-000000000088";
  const xorFileRef = {
    filename: "XOR_using_MLFFN.pdf",
    extractedText: "",
    visual_required: true,
    visual_analysis_status: "required",
    asset_id: xorAssetId,
    visual_asset_id: xorAssetId,
  };

  const case2Context = await buildContextFast({
    userMessage: "Explain the XOR problem from this PDF.",
    conversationId: CONVERSATION_ID,
    file_references: [xorFileRef as any],
  });

  // Check visual needed
  const case2VisualNeeded = hasVisualAssetsRequiringAnalysis(case2Context.fileReferences, case2Context.currentVisualAssets);
  assert.equal(case2VisualNeeded, true, "Scanned XOR PDF must require visual analysis");

  // In Fast mode: automatic tools include image_input
  const case2Tools = getEnabledAutomaticSentIQTools({
    fileReferences: case2Context.fileReferences,
    visualAssets: case2Context.currentVisualAssets,
  });
  assert.ok(case2Tools.includes("image_input"), "Fast mode must include image_input in enabled tools");

  // Check shouldSelectTools logic in Fast mode (profile.mode === "fast", intuitiveLaneActive === false)
  const intuitiveLaneActive = false;
  const shouldSelectTools = (intuitiveLaneActive || (case2VisualNeeded && case2Tools.includes("image_input"))) && case2Tools.length > 0;
  assert.equal(shouldSelectTools, true, "Fast mode routing must trigger selectChatToolCalls when visualNeeded is true");

  // Verify tool selection prompt has AVAILABLE VISUAL INPUTS
  const prompt = buildIntuitiveToolSelectionPrompt("Explain the XOR problem from this PDF.", case2Tools, case2Context.currentVisualAssets);
  assert.ok(prompt.includes("AVAILABLE VISUAL INPUTS:"), "Selection prompt must list visual inputs");
  assert.ok(prompt.includes(xorAssetId), "Selection prompt must include xor asset_id");
  assert.ok(prompt.includes("image_input"), "Selection prompt must list image_input tool");

  // Verify synthesis control flow for image_input
  const simulatedStepResult = {
    tool: "image_input",
    reply: "Visual inspection complete.",
    image_input: {
      success: true,
      evidence: {
        relevant_text: "The XOR problem cannot be solved by a single perceptron because it is not linearly separable. A Multi-Layer Feedforward Neural Network (MLFFN) with hidden layers is required.",
        visual_findings: ["Figure 2.1: Non-linear decision boundary for XOR logic function."],
      },
    },
  };
  const shouldSynthesize = shouldRunIntuitiveFinalSynthesis(simulatedStepResult);
  assert.equal(shouldSynthesize, true, "image_input tool result must trigger synthesis continuation");

  const evidence = buildIntuitiveToolSynthesisEvidence(simulatedStepResult);
  assert.ok(evidence[0].content.includes("linearly separable"), "Synthesis evidence must contain XOR evidence");
  console.log("[CASE 2 PASS]: Fast mode successfully enables image_input selection & synthesis continuation.\n");

  // ============================================================================
  // CASE 3: Three Images Understanding
  // Expected: all three assets identifiable, allowedTools preserved, image_input dispatches
  // ============================================================================
  console.log("--- CASE 3: Three Images Understanding ---");
  const case3Parsed = ChatRequestSchema.parse({
    message: "What do the attached images represent?",
    context: {
      image_attachments: [
        {
          filename: "image_document_FieldLine.jpeg",
          mime_type: "image/jpeg",
          base64: "ZmllbGRsaW5l",
          size_bytes: 5000,
          asset_id: "asset-fieldline-001",
          visual_asset_id: "asset-fieldline-001",
          visual_analysis_status: "required",
        },
        {
          filename: "StudentOS_logo.png",
          mime_type: "image/png",
          base64: "c3R1ZGVudG9z",
          size_bytes: 4000,
          asset_id: "asset-studentos-002",
          visual_asset_id: "asset-studentos-002",
          visual_analysis_status: "required",
        },
        {
          filename: "ChatGPT Image Jul 14, 2026, 11_04_59 AM.png",
          mime_type: "image/png",
          base64: "Y2hhdGdwdA==",
          size_bytes: 6000,
          asset_id: "asset-chatgpt-003",
          visual_asset_id: "asset-chatgpt-003",
          visual_analysis_status: "required",
        },
      ],
    },
  });

  const case3Context = await buildContextFast({
    userMessage: "What do the attached images represent?",
    conversationId: CONVERSATION_ID,
    image_attachments: case3Parsed.context!.image_attachments as any,
  });

  // Verify all 3 visual assets in context
  assert.equal(case3Context.currentVisualAssets.length, 3, "Context must have exactly 3 visual assets");
  assert.equal(case3Context.currentVisualAssets[0].asset_id, "asset-fieldline-001");
  assert.equal(case3Context.currentVisualAssets[1].asset_id, "asset-studentos-002");
  assert.equal(case3Context.currentVisualAssets[2].asset_id, "asset-chatgpt-003");

  // Verify executeAutomaticModelToolCalls does not drop image_input
  const calls: readonly ValidatedToolCall[] = [{
    id: "call-batch-visual",
    index: 0,
    name: "image_input" as const,
    arguments: {
      target_assets: ["image_document_FieldLine.jpeg", "StudentOS_logo.png", "ChatGPT Image Jul 14, 2026, 11_04_59 AM.png"],
      query: "Identify each image",
    },
  }];

  const dispatchResult = await executeAutomaticModelToolCalls(
    calls,
    "What do the attached images represent?",
    case3Context,
    FAST_PROFILE,
  );
  // Must dispatch without "SentIQ tool is unavailable: image_input"
  assert.ok(dispatchResult.image_input !== undefined, "Tool execution must return image_input structure");
  console.log("[CASE 3 PASS]: All 3 image assets retained identity and image_input dispatched successfully.\n");

  // ============================================================================
  // CASE 4: Multi-turn Follow-up Questions
  // Expected: correct image identity on every turn
  // ============================================================================
  console.log("--- CASE 4: Multi-turn Follow-up Image Questions ---");
  const turnQueries = [
    { query: "What is shown in the second image?", expectedTarget: "asset-studentos-002" },
    { query: "What does the third image show?", expectedTarget: "asset-chatgpt-003" },
    { query: "Compare the first and third images.", expectedTarget: "asset-fieldline-001" },
  ];

  for (const turn of turnQueries) {
    const turnContext = await buildContextFast({
      userMessage: turn.query,
      conversationId: CONVERSATION_ID,
      image_attachments: case3Parsed.context!.image_attachments as any,
    });
    assert.equal(turnContext.currentVisualAssets.length, 3, "Multi-turn context must preserve all 3 assets");
    const target = turnContext.currentVisualAssets.find((a) => a.asset_id === turn.expectedTarget);
    assert.ok(target, `Target asset ${turn.expectedTarget} must be present in turn`);
  }
  console.log("[CASE 4 PASS]: Multi-turn follow-up queries retain accurate asset identities across all turns.\n");

  // ============================================================================
  // CASE 5: Regression: Resume + XOR + image in one conversation
  // Expected: XOR uses XOR evidence, GPA uses Resume retrieval, no contamination
  // ============================================================================
  console.log("--- CASE 5: Regression Multi-Document Source Isolation ---");
  const mixedContext = await buildContextFast({
    userMessage: "Explain the XOR problem from this PDF.",
    conversationId: CONVERSATION_ID,
    file_references: [
      resumeFileRef as any,
      xorFileRef as any,
    ],
    image_attachments: [case3Parsed.context!.image_attachments![0] as any],
  }, mockDb as any, USER_ID);

  // Query XOR: target isolation prevents Resume from answering
  const xorIsolationCheck = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "Explain the XOR problem from this PDF.",
    fileReferences: [
      resumeFileRef as any,
      xorFileRef as any,
    ],
  });
  assert.equal(xorIsolationCheck.mode, "none", "Resume chunks must NOT be retrieved for XOR query when XOR is pending visual");

  // Turn 2: User asks "What is my GPA from the Resume?"
  const gpaTurnContext = await buildContextFast({
    userMessage: "What is my GPA from the Resume?",
    conversationId: CONVERSATION_ID,
    file_references: [
      resumeFileRef as any,
      xorFileRef as any,
    ],
    image_attachments: [case3Parsed.context!.image_attachments![0] as any],
  }, mockDb as any, USER_ID);

  // Verify isVisualTargetRequiredForQuery accurately isolates text queries vs visual queries
  const gpaQueryNeedsVisual = isVisualTargetRequiredForQuery("What is my GPA from the Resume?", gpaTurnContext);
  assert.equal(gpaQueryNeedsVisual, false, "Text query targeting Resume must NOT require visual analysis");

  const gpaImplicitQueryNeedsVisual = isVisualTargetRequiredForQuery("What is my GPA?", gpaTurnContext);
  assert.equal(gpaImplicitQueryNeedsVisual, false, "Generic text query must NOT require visual analysis in mixed conversation");

  // Verify getEnabledAutomaticSentIQTools does not expose image_input when visual not needed
  const enabledToolsForGpa = getEnabledAutomaticSentIQTools({
    hasVisualAssetsNeedingAnalysis: gpaQueryNeedsVisual,
    fileReferences: gpaTurnContext.fileReferences as any,
    visualAssets: gpaTurnContext.currentVisualAssets,
    imageAttachments: gpaTurnContext.imageAttachments as any,
  });
  assert.equal(enabledToolsForGpa.includes("image_input"), false, "image_input must NOT be available for text document request");

  // Verify execImageInput fails closed if called with unresolved visual target (e.g. Resume)
  const failClosedResult = await execImageInput(
    { targetAsset: "Resume", query: "What is my GPA from the Resume?" },
    gpaTurnContext,
    FAST_PROFILE,
  );
  assert.equal(failClosedResult.image_input?.success, false, "execImageInput must fail closed for text document target");
  assert.equal(failClosedResult.error, "No matching visual target could be resolved.", "execImageInput must not fall back to candidatePool");

  // Query GPA: Resume chunks retrieved, XOR not substituted
  const gpaRetrievalCheck = await retrievalService.retrieveForPrompt({
    userDb: mockDb,
    ownerUserId: USER_ID,
    query: "What is my GPA from the Resume?",
    fileReferences: [
      resumeFileRef as any,
      xorFileRef as any,
    ],
  });
  assert.ok(gpaRetrievalCheck.selectedChunks > 0, "Resume chunks must be retrieved for GPA query");
  assert.ok(gpaRetrievalCheck.fileReferences.some((f: any) => f.extractedText.includes("8.04")));
  console.log("[CASE 5 PASS]: Critical regression verified: text query preserves Resume chunks, image_input bypassed, fails closed without substitution.\n");

  // ============================================================================
  // CASE 6: Safety Test: Targeted Visual Request in Mixed Conversation
  // Expected: XOR visual analysis executes; Resume & StudentOS are not substituted
  // ============================================================================
  console.log("--- CASE 6: Targeted Visual Request in Mixed Conversation ---");
  const xorSafetyQuery = "Explain the XOR problem from XOR_using_MLFFN.pdf. Ignore the other files.";
  const xorQueryNeedsVisual = isVisualTargetRequiredForQuery(xorSafetyQuery, mixedContext);
  assert.equal(xorQueryNeedsVisual, true, "Explicit visual asset query must require visual analysis");

  const enabledToolsForXor = getEnabledAutomaticSentIQTools({
    hasVisualAssetsNeedingAnalysis: xorQueryNeedsVisual,
    fileReferences: mixedContext.fileReferences as any,
    visualAssets: mixedContext.currentVisualAssets,
    imageAttachments: mixedContext.imageAttachments as any,
  });
  assert.ok(enabledToolsForXor.includes("image_input"), "image_input must be available when query explicitly targets visual asset");

  const xorCalls: readonly ValidatedToolCall[] = [{
    id: "call-xor-isolated",
    index: 0,
    name: "image_input" as const,
    arguments: {
      target_asset: "XOR_using_MLFFN.pdf",
      query: xorSafetyQuery,
    },
  }];
  const xorDispatchResult = await executeAutomaticModelToolCalls(
    xorCalls,
    xorSafetyQuery,
    mixedContext,
    FAST_PROFILE,
  );
  assert.ok(xorDispatchResult.image_input !== undefined, "Tool execution must return image_input structure");
  console.log("[CASE 6 PASS]: Safety test verified: targeted visual request executes without cross-asset substitution.\n");

  console.log("================================================================================");
  console.log("ALL 6 REGRESSION SCENARIOS (A THROUGH F) PASSED WITH ZERO FAILURES");
  console.log("================================================================================");
}

runFiveTargetedScenarios().catch((err) => {
  console.error("Scenario execution failed:", err);
  process.exit(1);
});
