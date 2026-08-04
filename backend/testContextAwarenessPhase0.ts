import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  composeContextDetailed,
  type ComposerInput,
  type ContextCompositionTelemetry,
} from "./orchestrator/contextComposer";
import { selectMemoriesForQuery } from "./context/memorySelector";
import { chunkSourceText } from "./context/sourceChunker";
import {
  SourceRetrievalService,
  scoreSourceChunkLexical,
  type SourceChunkHit,
  type SourceDocumentRow,
} from "./services/sourceRetrievalService";

const EVALUATION_SCHEMA_VERSION = 1;
const TARGET_CONSTRAINT_RETENTION_RATE = 0.95;
const TARGET_FALSE_RECALL_RATE = 0.02;
const TARGET_PDF_PAGE_RETRIEVAL_RATE = 0.95;
const REPORT_PATH = process.env.SENTIQ_CONTEXT_EVAL_REPORT?.trim();
const ENFORCE_TARGETS = process.env.SENTIQ_CONTEXT_EVAL_ENFORCE_TARGETS === "1";

interface MarkerCheck {
  readonly marker: string;
  readonly present: boolean;
}

interface CompositionScenarioResult {
  readonly id: string;
  readonly category: string;
  readonly elapsedMs: number;
  readonly promptSha256: string;
  readonly requiredMarkers: readonly MarkerCheck[];
  readonly forbiddenMarkers: readonly MarkerCheck[];
  readonly passed: boolean;
  readonly telemetry: ContextCompositionTelemetry;
}

interface PdfRetrievalResult {
  readonly page: number;
  readonly mode: string;
  readonly selectedChunks: number;
  readonly correctPageSelected: boolean;
}

interface StaticFinding {
  readonly id: string;
  readonly detected: boolean;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly description: string;
}

interface Phase0Report {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly commit: string;
  readonly enforcementEnabled: boolean;
  readonly targets: {
    readonly constraintRetentionRate: number;
    readonly maximumFalseRecallRate: number;
    readonly pdfPageRetrievalRate: number;
  };
  readonly metrics: {
    readonly constraintRetentionRate: number;
    readonly falseRecallRate: number;
    readonly pdfPageRetrievalRate: number;
    readonly averageFinalInputTokens: number;
    readonly averageCompositionMs: number;
    readonly modelCallsPerformed: 0;
  };
  readonly compositionScenarios: readonly CompositionScenarioResult[];
  readonly pdfRetrieval: readonly PdfRetrievalResult[];
  readonly memoryChecks: {
    readonly unrelatedMemorySelections: number;
    readonly projectSynonymSelections: number;
    readonly conflictingPreferenceSelections: number;
  };
  readonly staticFindings: readonly StaticFinding[];
  readonly notes: readonly string[];
}

const SYSTEM_PROMPT = "SYSTEM: Follow the user request and preserve supplied constraints.";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function makeConversation(turns: number, anchor: string): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: `Permanent delivery constraint: ${anchor}` },
    { role: "assistant", content: "Understood. I will preserve that delivery constraint." },
  ];
  for (let index = 1; index < turns; index += 1) {
    messages.push(
      { role: "user", content: `Routine progress update ${index}. Keep the implementation bounded and reversible.` },
      { role: "assistant", content: `Recorded progress update ${index}. No provider setting was changed.` },
    );
  }
  return messages;
}

function evaluateComposition(args: {
  readonly id: string;
  readonly category: string;
  readonly input: ComposerInput;
  readonly requiredMarkers: readonly string[];
  readonly forbiddenMarkers?: readonly string[];
}): CompositionScenarioResult {
  const startedAt = process.hrtime.bigint();
  const result = composeContextDetailed(args.input);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const requiredMarkers = args.requiredMarkers.map((marker) => ({
    marker,
    present: result.prompt.includes(marker),
  }));
  const forbiddenMarkers = (args.forbiddenMarkers ?? []).map((marker) => ({
    marker,
    present: result.prompt.includes(marker),
  }));
  return {
    id: args.id,
    category: args.category,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    promptSha256: hash(result.prompt),
    requiredMarkers,
    forbiddenMarkers,
    passed: requiredMarkers.every((item) => item.present) && forbiddenMarkers.every((item) => !item.present),
    telemetry: result.telemetry,
  };
}

function sourceDocument(): SourceDocumentRow {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    owner_user_id: "00000000-0000-4000-8000-000000000011",
    conversation_id: "00000000-0000-4000-8000-000000000012",
    title: "synthetic-long-report.pdf",
    original_filename: "synthetic-long-report.pdf",
    mime_type: "application/pdf",
    source_type: "pdf",
    content_hash: "a".repeat(64),
    status: "ready",
    metadata: { page_count: 120 },
    referenceIndexes: [0],
  };
}

function pageHit(page: number): SourceChunkHit {
  const marker = `needle-page-${page}`;
  return {
    chunkId: `child-${page}`,
    documentId: sourceDocument().id,
    parentChunkId: `parent-${page}`,
    title: sourceDocument().title,
    chunkIndex: page - 1,
    content: `Page ${page} contains the unique answer marker ${marker}.`,
    contextPrefix: `${sourceDocument().title} > Page ${page}`,
    parentContent: `Synthetic report page ${page}. The unique answer marker is ${marker}. Supporting discussion remains local to this page.`,
    parentContextPrefix: `${sourceDocument().title} > Page ${page}`,
    heading: `Page ${page}`,
    path: sourceDocument().title,
    pageNumber: page,
    relevance: 0,
  };
}

async function evaluatePdfRetrieval(): Promise<PdfRetrievalResult[]> {
  const candidates = Array.from({ length: 120 }, (_, index) => pageHit(index + 1));
  const service = new SourceRetrievalService({
    resolveDocuments: async () => [sourceDocument()],
    lexicalSearch: async ({ query, limit }) => candidates
      .map((candidate) => ({
        ...candidate,
        relevance: scoreSourceChunkLexical(
          candidate.content,
          `${candidate.contextPrefix ?? ""} ${candidate.heading ?? ""}`,
          query,
        ),
      }))
      .sort((left, right) => right.relevance - left.relevance || left.chunkIndex - right.chunkIndex)
      .slice(0, limit),
  });

  const checks: PdfRetrievalResult[] = [];
  for (const page of [1, 60, 120]) {
    const marker = `needle-page-${page}`;
    const result = await service.retrieveForPrompt({
      userDb: { phase0: true },
      ownerUserId: sourceDocument().owner_user_id,
      query: `Find ${marker}`,
      fileReferences: [{
        filename: sourceDocument().title,
        extractedText: "Legacy fallback must not replace a resolved persisted source.",
        sourceDocumentId: sourceDocument().id,
      }],
    });
    const combined = result.fileReferences.map((reference) => reference.extractedText).join("\n");
    checks.push({
      page,
      mode: result.mode,
      selectedChunks: result.selectedChunks,
      correctPageSelected: combined.includes(marker) && combined.includes(`Page ${page}`),
    });
  }
  return checks;
}

async function scanStaticFindings(): Promise<StaticFinding[]> {
  const ingestionSource = await readFile(resolve(__dirname, "ai/FileIngestionHandler.ts"), "utf8");
  const retrievalSource = await readFile(resolve(__dirname, "services/sourceRetrievalService.ts"), "utf8");
  return [
    {
      id: "pdf-canonical-text-truncated",
      detected: /MAX_PDF_CHARS\s*=\s*50_000/.test(ingestionSource)
        && /cleaned\.slice\(0,\s*MAX_PDF_CHARS\)/.test(ingestionSource),
      severity: "critical",
      description: "Canonical PDF extraction is truncated to 50,000 characters before persisted retrieval can index later pages.",
    },
    {
      id: "pdf-upload-cap-10mb",
      detected: /MAX_FILE_SIZE\s*=\s*10\s*\*\s*1024\s*\*\s*1024/.test(ingestionSource),
      severity: "medium",
      description: "The upload path currently rejects files larger than 10 MB.",
    },
    {
      id: "pdf-page-provenance-missing",
      detected: /chunkSourceText\(\{\s*text:\s*args\.extractedText,\s*title:\s*args\.filename,\s*path:\s*args\.filename\s*\}\)/s.test(retrievalSource),
      severity: "high",
      description: "Persisted source chunking receives the combined text without page boundaries, so PDF page metadata cannot be populated.",
    },
    {
      id: "source-semantic-retriever-unwired",
      detected: /export const sourceRetrievalService\s*=\s*new SourceRetrievalService\(\);/.test(retrievalSource),
      severity: "high",
      description: "The production source retrieval singleton is created without a semantic-search dependency and therefore uses lexical retrieval only.",
    },
  ];
}

async function main(): Promise<void> {
  const rawHistoryMarkers = [
    { turns: 10, marker: "ANCHOR-10-TURNS" },
    { turns: 30, marker: "ANCHOR-30-TURNS" },
    { turns: 100, marker: "ANCHOR-100-TURNS" },
  ];
  const compositionScenarios: CompositionScenarioResult[] = rawHistoryMarkers.map(({ turns, marker }) =>
    evaluateComposition({
      id: `raw-history-${turns}-turns`,
      category: "constraint_retention",
      input: {
        systemPrompt: SYSTEM_PROMPT,
        conversation: makeConversation(turns, marker),
        userMessage: "What permanent delivery constraint did I set at the beginning?",
        tokenBudget: 6_000,
      },
      requiredMarkers: [marker],
    }));

  compositionScenarios.push(
    evaluateComposition({
      id: "capsule-assisted-long-thread",
      category: "constraint_retention",
      input: {
        systemPrompt: SYSTEM_PROMPT,
        conversation: makeConversation(100, "RAW-ANCHOR-MAY-BE-DROPPED"),
        conversationCapsule: "Durable active constraint: CAPSULE-ANCHOR-PRESERVED.",
        userMessage: "What permanent delivery constraint must remain active?",
        tokenBudget: 6_000,
      },
      requiredMarkers: ["CAPSULE-ANCHOR-PRESERVED"],
    }),
    evaluateComposition({
      id: "current-message-middle-constraint",
      category: "current_message_retention",
      input: {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: [
          "HEAD ".repeat(1_200),
          "MIDDLE-CONSTRAINT-NO-PROVIDER-CHANGES",
          " TAIL".repeat(1_200),
        ].join(""),
        tokenBudget: 420,
      },
      requiredMarkers: ["MIDDLE-CONSTRAINT-NO-PROVIDER-CHANGES"],
    }),
    evaluateComposition({
      id: "file-evidence-priority",
      category: "file_context",
      input: {
        systemPrompt: SYSTEM_PROMPT,
        fileReferences: [{
          filename: "requirements.pdf",
          extractedText: "RETRIEVED-PDF-ANSWER: The approved launch date is 18 August 2026.",
          retrieved: true,
          relevance: 1,
          sourceChunkCount: 1,
        }],
        memories: [{
          type: "project",
          summary: "Unrelated project preference: use a blue dashboard.",
          importance: 8,
          relevance: 0.1,
        }],
        userMessage: "What launch date does the attached PDF approve?",
        tokenBudget: 900,
      },
      requiredMarkers: ["RETRIEVED-PDF-ANSWER"],
    }),
  );

  compositionScenarios.forEach((scenario) => {
    assert.equal(scenario.telemetry.protectedFloorFailed, false, `${scenario.id} must preserve the protected prompt floor`);
    assert(scenario.telemetry.finalEstimatedInputTokens <= scenario.telemetry.inputContextCeilingTokens,
      `${scenario.id} must remain within its input-context ceiling`);
  });

  const memories = [
    { type: "identity", summary: "The user's name is Sounak.", importance: 9 },
    { type: "project", summary: "SentIQ chatbot rollout must preserve minReplicas=0.", importance: 9 },
    { type: "preference", summary: "The user prefers concise technical answers.", importance: 8 },
    { type: "preference", summary: "The user prefers exhaustive technical answers.", importance: 8 },
  ];
  const unrelatedMemorySelections = selectMemoriesForQuery(memories, "Explain photosynthesis in algae.", 6).length;
  const projectSynonymSelections = selectMemoriesForQuery(
    memories,
    "What did we decide for the chat assistant rollout?",
    6,
  ).length;
  const conflictingPreferenceSelections = selectMemoriesForQuery(
    memories,
    "What are my technical answer preferences?",
    6,
  ).filter((memory) => memory.type === "preference").length;

  assert.equal(unrelatedMemorySelections, 0, "Unrelated memory must not be injected into an ordinary factual query.");
  assert(projectSynonymSelections >= 1, "Chat-assistant synonyms should retrieve the related chatbot project memory.");

  const pdfRetrieval = await evaluatePdfRetrieval();
  assert(pdfRetrieval.every((item) => item.correctPageSelected), "Synthetic beginning, middle, and final PDF pages must be retrievable.");

  const longSourceMarker = "FINAL-SOURCE-MARKER-RETAINED";
  const longSource = `${Array.from({ length: 18_000 }, (_, index) => `sectionword${index}`).join(" ")} ${longSourceMarker}`;
  const chunks = chunkSourceText({ text: longSource, title: "long-source.pdf", path: "long-source.pdf" });
  assert(chunks.parents.length > 1 && chunks.children.length > chunks.parents.length,
    "Long textual sources must form multiple parent and child chunks.");
  assert(chunks.children.some((chunk) => chunk.content.includes(longSourceMarker)),
    "The source chunker itself must preserve a marker at the end of a long canonical source.");

  const constraintScenarios = compositionScenarios.filter((scenario) => scenario.category === "constraint_retention");
  const constraintMarkerChecks = constraintScenarios.flatMap((scenario) => scenario.requiredMarkers);
  const constraintRetentionRate = constraintMarkerChecks.length === 0
    ? 0
    : constraintMarkerChecks.filter((item) => item.present).length / constraintMarkerChecks.length;
  const falseRecallRate = unrelatedMemorySelections > 0 ? 1 : 0;
  const pdfPageRetrievalRate = pdfRetrieval.filter((item) => item.correctPageSelected).length / pdfRetrieval.length;
  const averageFinalInputTokens = compositionScenarios.reduce(
    (sum, scenario) => sum + scenario.telemetry.finalEstimatedInputTokens,
    0,
  ) / compositionScenarios.length;
  const averageCompositionMs = compositionScenarios.reduce(
    (sum, scenario) => sum + scenario.elapsedMs,
    0,
  ) / compositionScenarios.length;

  const report: Phase0Report = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA?.trim() || "local",
    enforcementEnabled: ENFORCE_TARGETS,
    targets: {
      constraintRetentionRate: TARGET_CONSTRAINT_RETENTION_RATE,
      maximumFalseRecallRate: TARGET_FALSE_RECALL_RATE,
      pdfPageRetrievalRate: TARGET_PDF_PAGE_RETRIEVAL_RATE,
    },
    metrics: {
      constraintRetentionRate: Number(constraintRetentionRate.toFixed(4)),
      falseRecallRate: Number(falseRecallRate.toFixed(4)),
      pdfPageRetrievalRate: Number(pdfPageRetrievalRate.toFixed(4)),
      averageFinalInputTokens: Number(averageFinalInputTokens.toFixed(2)),
      averageCompositionMs: Number(averageCompositionMs.toFixed(3)),
      modelCallsPerformed: 0,
    },
    compositionScenarios,
    pdfRetrieval,
    memoryChecks: {
      unrelatedMemorySelections,
      projectSynonymSelections,
      conflictingPreferenceSelections,
    },
    staticFindings: await scanStaticFindings(),
    notes: [
      "Phase 0 is an observational baseline. Target enforcement is disabled unless SENTIQ_CONTEXT_EVAL_ENFORCE_TARGETS=1.",
      "Prompt bodies are not written to the report. Only SHA-256 hashes, marker checks, counts, token estimates, and timings are recorded.",
      "The synthetic PDF retrieval test measures persisted lexical retrieval. Static findings separately identify information loss before persistence.",
      `Composition p95 for this deterministic local run: ${percentile(compositionScenarios.map((scenario) => scenario.elapsedMs), 0.95).toFixed(3)} ms.`,
    ],
  };

  if (REPORT_PATH) {
    await mkdir(dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));

  if (ENFORCE_TARGETS) {
    assert(report.metrics.constraintRetentionRate >= TARGET_CONSTRAINT_RETENTION_RATE,
      `Constraint retention ${report.metrics.constraintRetentionRate} is below ${TARGET_CONSTRAINT_RETENTION_RATE}.`);
    assert(report.metrics.falseRecallRate <= TARGET_FALSE_RECALL_RATE,
      `False recall ${report.metrics.falseRecallRate} exceeds ${TARGET_FALSE_RECALL_RATE}.`);
    assert(report.metrics.pdfPageRetrievalRate >= TARGET_PDF_PAGE_RETRIEVAL_RATE,
      `PDF page retrieval ${report.metrics.pdfPageRetrievalRate} is below ${TARGET_PDF_PAGE_RETRIEVAL_RATE}.`);
  }

  console.log("Contextual-awareness Phase 0 baseline completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
