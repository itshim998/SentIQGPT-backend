import assert from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  detectGeneratedFileFormat,
  getFileGenerationGuestInstruction,
  isFileGenerationRequest,
  isImpliedFileGenerationRequest,
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
  assert.equal(isFileGenerationRequest("Create a downloadable docx document about AI"), true);
  assert.equal(isFileGenerationRequest("Create a .html typing animation document"), true);
  assert.equal(isFileGenerationRequest("Create a .txt summary"), true);
  assert.equal(isFileGenerationRequest("Create a 5-slide presentation"), false);
  assert.equal(isImpliedFileGenerationRequest("Create a 5-slide presentation"), true);
  assert.equal(isFileGenerationRequest("Make an HTML document with a typing animation"), false);
  assert.equal(isImpliedFileGenerationRequest("Make an HTML document with a typing animation"), true);
  assert.deepEqual(
    resolveFileGenerationIntent("Create a .docx presentation script").format,
    "docx",
  );
  assert.equal(isFileGenerationRequest("What is HTML?"), false);
  assert.match(
    getFileGenerationGuestInstruction("Create an xlsx project tracker"),
    /Markdown table/i,
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
  assert.equal(result.file_name, "doc.txt");
  assert.equal(result.model_used, "openai-large");
  assert.equal(result.fallback, true);
  assert.match(result.fallback_reason || "", /json|parse|Unexpected/i);
  assert.equal(savedMetadata?.fileName, "doc.txt");
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
                { Task: "Draft", Owner: "Mira", Status: "Done" },
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

function sourceBlock(source: string, needle: string, chars = 1800): string {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `Expected source to include ${needle}`);
  return source.slice(start, start + chars);
}

function testStorageApiSourceGuards(): void {
  const server = readFileSync(resolve(__dirname, "server.ts"), "utf8");
  const storage = readFileSync(resolve(__dirname, "tools/fileGeneration/fileStorageService.ts"), "utf8");

  const lookupBlock = sourceBlock(server, "async function getGeneratedFileRowOrThrow");
  assert.match(lookupBlock, /\.eq\("id", fileId\)/, "generated file lookup should select by file id");
  assert.match(lookupBlock, /\.eq\("user_id", userId\)/, "generated file lookup should enforce ownership");

  const signedUrlBlock = sourceBlock(server, "async function createGeneratedFileSignedUrl");
  assert.match(signedUrlBlock, /createSignedUrl\(row\.storage_path,\s*120/, "download and preview should issue short-lived signed URLs");
  assert.match(signedUrlBlock, /legacy:\s*true/, "legacy public generated files should remain readable");

  const patchBlock = sourceBlock(server, '"/api/generated-files/:id"', 3200);
  assert.match(patchBlock, /verifyJWT\(\{ allowGuest: false \}\)/, "HTML replacement endpoint should require auth");
  assert.match(patchBlock, /GeneratedFileUpdateRequestSchema\.safeParse/, "HTML replacement endpoint should validate input");
  assert.match(patchBlock, /row\.format !== "html"/, "HTML replacement endpoint should reject non-HTML formats");
  assert.match(patchBlock, /generated_file_version_conflict/, "HTML replacement endpoint should reject stale versions");
  assert.match(patchBlock, /uploadGeneratedFileReplacement/, "HTML replacement endpoint should store a new private version");
  assert.match(patchBlock, /\.eq\("generated_file_id", fileId\)/, "HTML replacement should update linked assistant file messages");

  assert.match(storage, /sentiq-generated-files-private/, "new generated files should default to the private bucket");
  assert.match(storage, /public:\s*false/, "generated file bucket should be private");
  assert.match(storage, /v\$\{version\}/, "generated file storage paths should be versioned");
  assert.match(storage, /contentSha256/, "generated file uploads should hash content");
}

async function main(): Promise<void> {
  installSupabaseEnvForImports();
  ({ routeFileGeneration } = await import("./tools/fileGeneration/fileGenerator"));
  await testFileIntentDetection();
  await testMinimaxFallbackAndMetadata();
  await testXlsxRendererValidation();
  await testDocxRepairsSlideShape();
  testStorageApiSourceGuards();
  console.log("file generation tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
