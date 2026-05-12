import assert from "assert";
import { detectGeneratedFileFormat, getFileGenerationGuestInstruction, isFileGenerationRequest } from "./tools/fileGeneration/fileDetector";
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
  assert.equal(detectGeneratedFileFormat("Export this as a PDF"), "pdf");
  assert.equal(isFileGenerationRequest("Create a downloadable docx document about AI"), true);
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
                ["Research", "Aarav", "Pending"],
                ["Draft", "Mira", "Done"],
                ["Review", "Kunal", "Pending"],
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
}

async function main(): Promise<void> {
  installSupabaseEnvForImports();
  ({ routeFileGeneration } = await import("./tools/fileGeneration/fileGenerator"));
  await testFileIntentDetection();
  await testMinimaxFallbackAndMetadata();
  await testXlsxRendererValidation();
  console.log("file generation tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
