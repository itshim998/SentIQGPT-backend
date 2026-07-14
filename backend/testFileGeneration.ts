import assert from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  detectGeneratedFileFormat,
  resolveFileGenerationIntent,
} from "./tools/fileGeneration/fileDetector";
import type { LLMAdapterResult } from "./ai/PromptBuilders";

type RouteFileGeneration = typeof import("./tools/fileGeneration/fileGenerator").routeFileGeneration;

let routeFileGeneration: RouteFileGeneration;

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
      callModel: async () => llmResult("nope", "minimax"),
      uploadFile: async () => {
        throw new Error("upload should not be called after render failure");
      },
      saveMetadata: async () => {},
      storageDb: {},
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.format, "pdf");
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
  ({ routeFileGeneration } = await import("./tools/fileGeneration/fileGenerator"));
  await testFileIntentDetection();
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
