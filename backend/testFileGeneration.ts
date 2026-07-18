import assert from "assert";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  detectGeneratedFileFormat,
  resolveFileGenerationIntent,
} from "./tools/fileGeneration/fileDetector";
import type { LLMAdapterResult } from "./ai/PromptBuilders";
import { buildContextFast } from "./context/contextBuilder";
import { FAST_PROFILE } from "./orchestrator/executionProfile";

type RouteFileGeneration = typeof import("./tools/fileGeneration/fileGenerator").routeFileGeneration;
type ParseGeneratedFileSpec = typeof import("./tools/fileGeneration/fileGenerator").parseGeneratedFileSpec;
type RenderPdf = typeof import("./tools/fileGeneration/fileGenerator").renderPdf;

let routeFileGeneration: RouteFileGeneration;
let parseGeneratedFileSpec: ParseGeneratedFileSpec;
let renderPdf: RenderPdf;

function installSupabaseEnvForImports(): void {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
}

function llmResult(text: string, model: string): LLMAdapterResult {
  return { text, model_used: model, finish_reason: "stop", truncated: false };
}

async function testFileIntentDetection(): Promise<void> {
  assert.equal(detectGeneratedFileFormat("Generate a .xlsx project tracker"), "xlsx");
  assert.equal(detectGeneratedFileFormat("Create a 5-slide presentation"), "pptx");
  assert.equal(detectGeneratedFileFormat("Create a .docx document containing my presentation script"), "docx");
  assert.equal(detectGeneratedFileFormat("Export this as a PDF"), "pdf");
  assert.deepEqual(
    resolveFileGenerationIntent("Create a .docx presentation script").format,
    "docx",
  );
}

async function testMinimaxFallbackAndMetadata(): Promise<void> {
  const calls: string[] = [];
  let savedMetadata: any = null;

  const result = await routeFileGeneration(
    {
      userMessage: "Create a text file with a short project summary as .txt",
      userId: "00000000-0000-4000-8000-000000000001",
      conversationId: "00000000-0000-4000-8000-000000000002",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async (call) => {
        calls.push(call.model_override || "");
        if (calls.length === 1) return llmResult("not json", "minimax");
        return llmResult(
          JSON.stringify({
            title: "Project Summary",
            format: "txt",
            text: "This project summary is ready for a generated text file.",
          }),
          "openai-large",
        );
      },
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-1",
        fileUrl: "https://example.test/doc.txt",
        storagePath: `${params.userId}/${params.chatId}/file-1/doc.txt`,
        fileSizeBytes: params.buffer.length,
      }),
      saveMetadata: async (_client, params) => {
        savedMetadata = params;
      },
      storageDb: {},
    },
  );

  assert.deepEqual(calls, ["minimax", "openai-large"]);
  assert.equal(result.success, true);
  assert.equal(result.format, "txt");
  assert.equal(result.file_name, "project-summary.txt");
  assert.equal(result.model_used, "openai-large");
  assert.equal(result.fallback, true);
  assert.match(result.fallback_reason || "", /json|parse|Unexpected/i);
  assert.equal(savedMetadata?.fileName, "project-summary.txt");
  assert.equal(savedMetadata?.storagePath, "00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/file-1/doc.txt");
}

async function testLiveChatContextHandoffToPdfGeneration(): Promise<void> {
  const userDb = {};
  const userId = "00000000-0000-4000-8000-000000000021";
  const conversationId = "00000000-0000-4000-8000-000000000022";
  const userMessage = "Create a downloadable PDF containing a one-page Operating Systems study checklist.";
  const context = await buildContextFast(
    {
      recent_messages: [{ role: "user", content: userMessage }],
      userMessage,
      conversationId,
      clientRequestId: "request-file-context-handoff",
    },
    userDb as any,
    userId,
    { profile: FAST_PROFILE },
  );

  assert.equal(context.userDb, userDb, "the live context must retain the resolved database for file execution");
  const result = await routeFileGeneration(
    {
      userMessage,
      requestedFormat: "pdf",
      userId: context.userId || "",
      conversationId: context.conversationId || "",
      userDb: context.userDb,
    },
    {},
    {
      callModel: async () => llmResult(JSON.stringify({
        title: "Operating Systems Study Checklist",
        format: "pdf",
        sections: [{
          heading: "Core topics",
          bullets: ["Processes and threads", "Memory management", "File systems"],
        }],
      }), "minimax"),
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-context-handoff",
        fileUrl: "/api/generated-files/file-context-handoff/download",
        storagePath: `${params.userId}/${params.chatId}/file-context-handoff/v1/doc.pdf`,
        storageBucket: "sentiq-generated-files-private",
        fileSizeBytes: params.buffer.length,
      }),
      saveMetadata: async () => undefined,
      storageDb: {},
    },
  );

  assert.equal(result.success, true, "the production calling convention must reach PDF rendering and storage");
  assert.equal(result.format, "pdf");
  assert.equal(result.file_id, "file-context-handoff");
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function testStructuredPdfNormalizationAndComposition(): Promise<void> {
  const nativeSpec = {
    title: "Present Awareness: A Full Month Plan",
    subtitle: "A practical rhythm for reconnecting with the world around you",
    introduction: "Use this plan gently. Notice what is here, then return without judging distraction.",
    format: "pdf",
    sections: [...Array.from({ length: 4 }, (_, weekIndex) => ({
      heading: `Week ${weekIndex + 1}: ${["Arrive", "Notice", "Participate", "Continue"][weekIndex]}`,
      body: [`This week develops present awareness through ordinary activities and a short evening review.`],
      subsections: Array.from({ length: 7 }, (_, dayIndex) => ({
        heading: `Day ${weekIndex * 7 + dayIndex + 1}: ${["Orient to the room", "Listen outward", "Walk with attention", "Share a meal", "Observe colour", "Join an activity", "Review the day"][dayIndex]}`,
        body: [`Spend ten minutes noticing concrete details in your surroundings. Name what changed, what stayed steady, and one way you participated in the present world.`],
        bullets: [
          "Anchor: identify five visible objects and three sounds.",
          "Action: complete one small task with your phone out of reach.",
          "Reflection: write one sentence about what you noticed.",
        ],
      })),
      ...(weekIndex === 2 ? { page_break_before: true } : {}),
    })), {
      heading: "Review and continuation",
      body: ["Keep the practices that made daily life feel more vivid and connected."],
      subsections: [],
      tables: [{
        caption: "Monthly review",
        headers: ["Question", "Notes"],
        rows: [
          ["Which outward anchors worked best?", "Record two dependable choices."],
          ["When did connection feel easiest?", "Note the setting and people involved."],
        ],
      }],
      callout: "Continuation checklist: choose three practices, schedule them, and review again in two weeks.",
    }],
    blocks: [{
      type: "paragraph",
      text: "Legitimate JSON example for journaling: {\"present\": true, \"next_step\": \"look outward\"}. Keep this source text visible.",
    }],
  };

  const variants: unknown[] = [
    nativeSpec,
    JSON.stringify(nativeSpec),
    JSON.stringify(JSON.stringify(nativeSpec)),
    { response: { data: JSON.stringify(nativeSpec), provider_error: "must never be visible" } },
    `Here is the requested document specification:\n${JSON.stringify(nativeSpec)}\nEnd of specification.`,
  ];
  for (const variant of variants) {
    const parsed = parseGeneratedFileSpec(variant, "pdf");
    assert.equal(parsed.title, nativeSpec.title);
    assert.equal(parsed.sections?.length, 5);
  }
  assert.throws(
    () => parseGeneratedFileSpec("I could not create the document. provider_error=bad_request", "pdf"),
    /invalid structured document specification/i,
    "malformed model output must be rejected rather than printed",
  );

  const reproductionPrompt = "Generate a .pdf file containing a full month plan on how to improve my awareness about the present, instead of delving inside the mind, disconnected from the present world.";
  const uploadedPdfs: Buffer[] = [];
  const result = await routeFileGeneration(
    {
      userMessage: reproductionPrompt,
      requestedFormat: "pdf",
      userId: "00000000-0000-4000-8000-000000000031",
      conversationId: "00000000-0000-4000-8000-000000000032",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async () => llmResult(JSON.stringify({
        response: JSON.stringify(nativeSpec),
        provider: "test-provider",
        provider_error: "must never be rendered",
      }), "minimax"),
      uploadFile: async (_client, params) => {
        uploadedPdfs.push(params.buffer);
        return {
          success: true,
          fileId: "month-plan-pdf",
          fileUrl: "/api/generated-files/month-plan-pdf/download",
          storagePath: "u/c/month-plan-pdf/v1/month-plan.pdf",
          storageBucket: "sentiq-generated-files-private",
          fileSizeBytes: params.buffer.length,
        };
      },
      saveMetadata: async () => undefined,
      storageDb: {},
    },
  );
  assert.equal(result.success, true, "the exact reproduction path should generate and persist a PDF");
  const uploadedPdf = uploadedPdfs[0];
  assert(uploadedPdf && uploadedPdf.length > 5_000, "the generated PDF should have a substantial valid buffer");
  assert.equal(uploadedPdf.subarray(0, 5).toString(), "%PDF-");

  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: uploadedPdf });
  const extracted = await parser.getText({ pageJoiner: "\n---PAGE---\n" });
  assert.ok(extracted.total >= 4, `the month plan should span multiple readable pages, got ${extracted.total}`);
  assert.match(extracted.text, /Present Awareness: A Full Month Plan/);
  assert.match(extracted.text, /Week 1: Arrive/);
  assert.match(extracted.text, /Day 28: Review the day/);
  assert.match(extracted.text, /Continuation checklist/);
  assert.match(extracted.text, /\{"present": true, "next_step": "look outward"\}/, "intentional JSON source text should remain visible");
  assert.ok(
    countOccurrences(extracted.text, nativeSpec.title) <= extracted.total,
    "the title may appear in page headers but wrapped payloads must not duplicate the document body",
  );
  assert.doesNotMatch(extracted.text, /provider_error|test-provider|\"sections\"|\"format\"\s*:/, "wrappers and schema fields must not become visible content");
  for (const page of extracted.pages) {
    assert.ok(page.text.replace(/Generated by SentIQ Chat|Page \d+ of \d+/g, "").trim().length > 40, `page ${page.num} should not be blank or obviously truncated`);
  }
  const screenshots = await parser.getScreenshot({ partial: [1, extracted.total], desiredWidth: 480, imageDataUrl: false, imageBuffer: true });
  assert.equal(screenshots.pages.length, 2, "first and last pages should render to images");
  for (const page of screenshots.pages) {
    assert.ok(page.data.length > 1_000 && page.width > 0 && page.height > 0, `page ${page.pageNumber} screenshot should be non-empty`);
  }
  const qaOutput = process.env.SENTIQ_PDF_QA_OUTPUT?.trim();
  if (qaOutput) {
    writeFileSync(`${qaOutput}.pdf`, uploadedPdf);
    screenshots.pages.forEach((page) => writeFileSync(`${qaOutput}-page-${page.pageNumber}.png`, page.data));
  }
  await parser.destroy();
}

async function testPdfLongContentAndUnicode(): Promise<void> {
  const longHeading = "A deliberately long subsection heading that must wrap cleanly and stay with the related activity below it rather than sitting alone at the bottom of a page";
  const longItem = "Observe the environment without rushing: notice changing light, nearby movement, texture, temperature, and sound; then choose one concrete action that reconnects you with the people or place around you.";
  const rendered = await renderPdf({
    title: "Unicode and Layout Check",
    subtitle: "Curly quotes “like this”, an em dash — plus café and naïve text",
    sections: [{
      heading: longHeading,
      body: Array.from({ length: 18 }, (_, index) => `Paragraph ${index + 1}: ${longItem}`),
      bullets: Array.from({ length: 12 }, (_, index) => `${longItem} Item ${index + 1}.`),
      page_break_after: true,
    }, {
      heading: "After the explicit page break",
      body: ["This concluding block verifies that explicit breaks preserve content and do not create a blank trailing page."],
    }],
  });
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: rendered.buffer });
  const extracted = await parser.getText();
  await parser.destroy();
  assert.ok(extracted.total >= 2);
  assert.match(extracted.text, /Unicode and Layout Check/);
  assert.match(extracted.text, /After the explicit page break/);
  assert.match(extracted.text, /café and naïve/);
  assert.match(extracted.text, /Paragraph 18/);
  assert.match(extracted.text, /Item 12/);
}

async function testXlsxRendererValidation(): Promise<void> {
  let uploadedMimeType = "";
  let uploadedSize = 0;
  const result = await routeFileGeneration(
    {
      userMessage: "Generate an xlsx spreadsheet with three tasks",
      userId: "00000000-0000-4000-8000-000000000003",
      conversationId: "00000000-0000-4000-8000-000000000004",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async () => llmResult(
        JSON.stringify({
          title: "Tasks",
          format: "xlsx",
          sheets: [
            {
              name: "Tasks",
              columns: ["Task", "Owner", "Status"],
              rows: [
                { Task: "Research", Owner: "Aarav", Status: "Pending" },
                { task: "Draft", owner: "Mira", status: "Done" },
                { Task: "Review", Owner: "Kunal", Status: "Pending" },
              ],
            },
          ],
        }),
        "minimax",
      ),
      uploadFile: async (_client, params) => {
        uploadedMimeType = params.mimeType;
        uploadedSize = params.buffer.length;
        return {
          success: true,
          fileId: "file-2",
          fileUrl: "https://example.test/doc.xlsx",
          storagePath: "u/c/file-2/doc.xlsx",
          fileSizeBytes: params.buffer.length,
        };
      },
      saveMetadata: async () => {},
      storageDb: {},
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.format, "xlsx");
  assert.equal(uploadedMimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(uploadedSize > 1000, "xlsx buffer should be non-empty");
  assert.deepEqual(result.preview?.sheet?.rows?.[0], ["Task", "Owner", "Status"]);
  assert.deepEqual(result.preview?.sheet?.rows?.[1], ["Research", "Aarav", "Pending"]);
  assert.deepEqual(result.preview?.sheet?.rows?.[2], ["Draft", "Mira", "Done"]);
  assert.equal(result.preview?.sheet?.row_count, 4);
  assert.equal(result.preview?.sheet?.column_count, 3);
  assert.equal(result.preview?.sheets?.[0]?.name, "Tasks");
}

async function testDocxRepairsSlideShape(): Promise<void> {
  const result = await routeFileGeneration(
    {
      userMessage: "Create a .docx document containing my presentation script",
      userId: "00000000-0000-4000-8000-000000000005",
      conversationId: "00000000-0000-4000-8000-000000000006",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async () => llmResult(
        JSON.stringify({
          title: "Speaking Script",
          format: "pptx",
          slides: [
            {
              title: "Opening",
              bullets: ["Welcome the class", "Introduce the topic"],
              notes: "Use a confident opening.",
            },
          ],
        }),
        "minimax",
      ),
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-3",
        fileUrl: "/api/generated-files/file-3/download",
        storagePath: "u/c/file-3/v1/doc.docx",
        storageBucket: "sentiq-generated-files-private",
        fileSizeBytes: params.buffer.length,
        contentSha256: "test-hash",
        version: 1,
      }),
      saveMetadata: async () => {},
      storageDb: {},
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.format, "docx");
  assert.match(result.preview?.text || "", /Opening/);
}

async function testHtmlFragmentRepairAndStreaming(): Promise<void> {
  const streamed: string[] = [];
  const result = await routeFileGeneration(
    {
      userMessage: "Create a .html greeting animation",
      userId: "00000000-0000-4000-8000-000000000015",
      conversationId: "00000000-0000-4000-8000-000000000016",
      userDb: {},
      storageDb: {},
    },
    {
      onHtmlToken: async (token) => {
        streamed.push(token);
      },
    },
    {
      callModel: async () => llmResult(
        "<main><h1>Hello world</h1><p>This fragment should be wrapped into a complete generated HTML document.</p></main>",
        "minimax",
      ),
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-7",
        fileUrl: "/api/generated-files/file-7/download",
        storagePath: "u/c/file-7/v1/greeting-animation.html",
        storageBucket: "sentiq-generated-files-private",
        fileSizeBytes: params.buffer.length,
        contentSha256: "html-hash",
        version: 1,
      }),
      saveMetadata: async () => {},
      storageDb: {},
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.format, "html");
  assert.match(result.html || "", /^<!DOCTYPE html>/i);
  assert.match(result.html || "", /Hello world/);
  assert.ok(streamed.join("").includes("Hello world"), "HTML streaming should emit repaired HTML content");
}

async function testPlainTextSlideOutlineRepair(): Promise<void> {
  const result = await routeFileGeneration(
    {
      userMessage: "Create a .pptx presentation about launch planning",
      userId: "00000000-0000-4000-8000-000000000007",
      conversationId: "00000000-0000-4000-8000-000000000008",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async () => llmResult(
        [
          "# Launch Planning",
          "Slide 1: Goals",
          "- Align owners",
          "- Confirm release scope",
          "Slide 2: Timeline",
          "- Prepare QA window",
          "- Publish launch checklist",
        ].join("\n"),
        "minimax",
      ),
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-4",
        fileUrl: "/api/generated-files/file-4/download",
        storagePath: "u/c/file-4/v1/launch-planning.pptx",
        storageBucket: "sentiq-generated-files-private",
        fileSizeBytes: params.buffer.length,
        contentSha256: "pptx-hash",
        version: 1,
      }),
      saveMetadata: async () => {},
      storageDb: {},
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.format, "pptx");
  assert.equal(result.file_name, "launch-planning.pptx");
  assert.ok((result.preview?.slides || []).length >= 2, "plain-text outline should become multiple slide previews");
  assert.match(result.preview?.slides?.[0]?.title || "", /Goals|Launch/i);
}

async function testMarkdownTableXlsxRepair(): Promise<void> {
  const result = await routeFileGeneration(
    {
      userMessage: "Create a .xlsx sprint tracker",
      userId: "00000000-0000-4000-8000-000000000009",
      conversationId: "00000000-0000-4000-8000-000000000010",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async () => llmResult(
        [
          "| Task | Owner | Status |",
          "| --- | --- | --- |",
          "| API tests | Dev | In progress |",
          "| UI polish | Design | Ready |",
        ].join("\n"),
        "minimax",
      ),
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-5",
        fileUrl: "/api/generated-files/file-5/download",
        storagePath: "u/c/file-5/v1/sprint-tracker.xlsx",
        storageBucket: "sentiq-generated-files-private",
        fileSizeBytes: params.buffer.length,
        contentSha256: "xlsx-hash",
        version: 1,
      }),
      saveMetadata: async () => {},
      storageDb: {},
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.format, "xlsx");
  assert.deepEqual(result.preview?.sheet?.rows?.[0], ["Task", "Owner", "Status"]);
  assert.deepEqual(result.preview?.sheet?.rows?.[1], ["API tests", "Dev", "In progress"]);
}

async function testFallbackFailureIsStructured(): Promise<void> {
  let modelCalls = 0;
  const result = await routeFileGeneration(
    {
      userMessage: "Create a .pdf roadmap brief",
      userId: "00000000-0000-4000-8000-000000000011",
      conversationId: "00000000-0000-4000-8000-000000000012",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async () => {
        modelCalls += 1;
        return llmResult("nope", "minimax");
      },
      uploadFile: async () => {
        throw new Error("upload should not be called after render failure");
      },
      saveMetadata: async () => {},
      storageDb: {},
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.format, "pdf");
  assert.equal(modelCalls, 2, "malformed PDF content should receive one bounded regeneration attempt");
  assert.match(result.error || "", /failed after fallback/i);
}

async function testMetadataFailureCleansUploadedObject(): Promise<void> {
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  const storageDb = {
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths });
          return { data: null, error: null };
        },
      }),
    },
  };

  const result = await routeFileGeneration(
    {
      userMessage: "Create a .txt release note",
      userId: "00000000-0000-4000-8000-000000000013",
      conversationId: "00000000-0000-4000-8000-000000000014",
      userDb: {},
      storageDb,
    },
    {},
    {
      callModel: async () => llmResult(
        JSON.stringify({
          title: "Release Note",
          format: "txt",
          text: "Release notes with enough content to render into a generated text file.",
        }),
        "minimax",
      ),
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-6",
        fileUrl: "/api/generated-files/file-6/download",
        storagePath: "u/c/file-6/v1/release-note.txt",
        storageBucket: "sentiq-generated-files-private",
        fileSizeBytes: params.buffer.length,
        contentSha256: "txt-hash",
        version: 1,
      }),
      saveMetadata: async () => {
        throw new Error("db unavailable");
      },
      storageDb,
    },
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /could not be saved/i);
  assert.deepEqual(removed, [{
    bucket: "sentiq-generated-files-private",
    paths: ["u/c/file-6/v1/release-note.txt"],
  }]);
}

async function testMetadataFailureReportsCleanupFailure(): Promise<void> {
  const result = await routeFileGeneration(
    {
      userMessage: "Create a text file with release notes as .txt",
      userId: "00000000-0000-4000-8000-000000000001",
      conversationId: "00000000-0000-4000-8000-000000000002",
      userDb: {},
      storageDb: {},
    },
    {},
    {
      callModel: async () => llmResult(
        JSON.stringify({
          title: "Release Note",
          format: "txt",
          text: "Release notes with enough content to render into a generated text file.",
        }),
        "minimax",
      ),
      uploadFile: async (_client, params) => ({
        success: true,
        fileId: "file-7",
        fileUrl: "/api/generated-files/file-7/download",
        storagePath: "u/c/file-7/v1/release-note.txt",
        storageBucket: "sentiq-generated-files-private",
        fileSizeBytes: params.buffer.length,
        contentSha256: "txt-hash",
        version: 1,
      }),
      saveMetadata: async () => {
        throw new Error("db unavailable");
      },
      deleteFile: async () => {
        throw new Error("storage unavailable");
      },
      storageDb: {},
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.cleanup_failed, true);
  assert.equal(result.orphaned_storage_bucket, "sentiq-generated-files-private");
  assert.equal(result.orphaned_storage_path, "u/c/file-7/v1/release-note.txt");
  assert.match(result.warning || "", /could not be cleaned up/i);
}

async function testModelSelectedFormatAndCancellationCleanup(): Promise<void> {
  const controller = new AbortController();
  let cleanupCalls = 0;
  await assert.rejects(
    () => routeFileGeneration(
      {
        userMessage: "Create a concise downloadable project report",
        requestedFormat: "txt",
        userId: "00000000-0000-4000-8000-000000000011",
        conversationId: "00000000-0000-4000-8000-000000000012",
        userDb: {},
        storageDb: {},
        signal: controller.signal,
      },
      {},
      {
        callModel: async () => llmResult(JSON.stringify({
          title: "Project report",
          format: "txt",
          text: "A concise project report generated from the user's request.",
        }), "minimax"),
        uploadFile: async () => {
          controller.abort(new Error("request cancelled"));
          return {
            success: true,
            fileId: "file-cancelled",
            fileUrl: "https://example.test/project-report.txt",
            storagePath: "u/c/file-cancelled/project-report.txt",
            storageBucket: "sentiq-generated-files-private",
            fileSizeBytes: 64,
          };
        },
        saveMetadata: async () => assert.fail("cancelled work must not persist metadata"),
        deleteFile: async () => { cleanupCalls += 1; },
        storageDb: {},
      },
    ),
    /request cancelled/,
  );
  assert.equal(cleanupCalls, 1, "a cancellation after upload cleans the orphan before propagating");

  const preCancelled = new AbortController();
  preCancelled.abort(new Error("cancelled before generation"));
  await assert.rejects(() => routeFileGeneration({
    userMessage: "Create a report",
    requestedFormat: "pdf",
    userId: "00000000-0000-4000-8000-000000000013",
    conversationId: "00000000-0000-4000-8000-000000000014",
    userDb: {},
    signal: preCancelled.signal,
  }), /cancelled before generation/);
}

function sourceBlock(source: string, needle: string, chars = 1800): string {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `Expected source to include ${needle}`);
  return source.slice(start, start + chars);
}

function testStorageApiSourceGuards(): void {
  const server = readFileSync(resolve(__dirname, "server.ts"), "utf8");
  const storage = readFileSync(resolve(__dirname, "tools/fileGeneration/fileStorageService.ts"), "utf8");
  const generator = readFileSync(resolve(__dirname, "tools/fileGeneration/fileGenerator.ts"), "utf8");

  const lookupBlock = sourceBlock(server, "async function getGeneratedFileRowOrThrow");
  assert.match(lookupBlock, /\.eq\("id", fileId\)/, "generated file lookup should select by file id");
  assert.match(lookupBlock, /\.eq\("user_id", userId\)/, "generated file lookup should enforce ownership");

  const signedUrlBlock = sourceBlock(server, "async function createGeneratedFileSignedUrl");
  assert.match(signedUrlBlock, /createSignedUrl\(row\.storage_path,\s*120/, "download and preview should issue short-lived signed URLs");
  assert.match(signedUrlBlock, /legacy:\s*true/, "legacy public generated files should remain readable");

  const patchBlock = sourceBlock(server, '"/api/generated-files/:id"', 7000);
  assert.match(patchBlock, /verifyJWT\(\{ allowGuest: false \}\)/, "HTML replacement endpoint should require auth");
  assert.match(patchBlock, /GeneratedFileUpdateRequestSchema\.safeParse/, "HTML replacement endpoint should validate input");
  assert.match(patchBlock, /row\.format !== "html"/, "HTML replacement endpoint should reject non-HTML formats");
  assert.match(patchBlock, /generated_file_version_conflict/, "HTML replacement endpoint should reject stale versions");
  assert.match(patchBlock, /serializeGeneratedFileRow\(row\)/, "version conflicts should include current server metadata");
  assert.match(patchBlock, /uploadGeneratedFileReplacement/, "HTML replacement endpoint should store a new private version");
  assert.match(patchBlock, /\.eq\("generated_file_id", fileId\)/, "HTML replacement should update linked assistant file messages");
  assert.match(patchBlock, /logDbFailure\("generated-files\.update\.messages"/, "message update failures should be logged");
  assert.match(patchBlock, /generated_file_message_metadata_update_failed/, "message update failures should be returned as degraded warnings");

  assert.match(storage, /sentiq-generated-files-private/, "new generated files should default to the private bucket");
  assert.match(storage, /public:\s*false/, "generated file bucket should be private");
  assert.match(storage, /v\$\{version\}/, "generated file storage paths should be versioned");
  assert.match(storage, /contentSha256/, "generated file uploads should hash content");
  assert.match(storage, /bucketName === DEFAULT_GENERATED_FILE_STORAGE_BUCKET/, "legacy public buckets should not be forcibly converted to private");
  assert.doesNotMatch(storage, /getPublicUrl/, "new uploads should not depend on public URLs");
  assert.match(generator, /deleteGeneratedFileObject/, "metadata failures should clean uploaded storage objects");
  assert.match(generator, /cleanup_failed/, "metadata cleanup failures should be surfaced in result metadata");
  assert.match(generator, /validateOfficeZip/, "Office files should be ZIP-structure validated");
}

async function main(): Promise<void> {
  installSupabaseEnvForImports();
  ({ routeFileGeneration, parseGeneratedFileSpec, renderPdf } = await import("./tools/fileGeneration/fileGenerator"));
  await testFileIntentDetection();
  await testLiveChatContextHandoffToPdfGeneration();
  await testStructuredPdfNormalizationAndComposition();
  await testPdfLongContentAndUnicode();
  await testMinimaxFallbackAndMetadata();
  await testXlsxRendererValidation();
  await testDocxRepairsSlideShape();
  await testHtmlFragmentRepairAndStreaming();
  await testPlainTextSlideOutlineRepair();
  await testMarkdownTableXlsxRepair();
  await testFallbackFailureIsStructured();
  await testMetadataFailureCleansUploadedObject();
  await testMetadataFailureReportsCleanupFailure();
  await testModelSelectedFormatAndCancellationCleanup();
  testStorageApiSourceGuards();
  console.log("file generation tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
