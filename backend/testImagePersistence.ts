import {
  buildImagePromptMessageContent,
  findExistingAssistantImageMessage,
  persistGeneratedImageResult,
} from "./services/generatedImagePersistenceService";

function assert(condition: boolean, label: string, detail?: string): void {
  if (!condition) {
    throw new Error(detail ? `${label} (${detail})` : label);
  }
  console.log(`PASS ${label}`);
}

async function testPersistGeneratedImageResult(): Promise<void> {
  const insertCalls: any[] = [];
  const uploadCalls: any[] = [];

  const insertMessage = async (_userDb: any, data: any) => {
    insertCalls.push({ ...data });
    return {
      data: {
        id: `${data.role}-${insertCalls.length}`,
        role: data.role,
        content: data.content,
        created_at: new Date().toISOString(),
        client_request_id: data.clientRequestId || null,
        message_type: data.messageType || "text",
        image_url: data.imageUrl || null,
        storage_path: data.storagePath || null,
        prompt: data.prompt || null,
        provider: data.provider || null,
        file_size_bytes: data.fileSizeBytes || null,
      },
      error: null,
      duplicate: false,
    };
  };

  const uploadImage = async (_userDb: any, params: any) => {
    uploadCalls.push({ ...params });
    return {
      success: true,
      imageUrl: "https://cdn.example.com/user/chat/generated.webp",
      storagePath: "user/chat/generated.webp",
      imageId: "img-1",
      fileSizeBytes: 12345,
    };
  };

  const result = await persistGeneratedImageResult(
    {
      userDb: {},
      userId: "user-1",
      conversationId: "chat-1",
      prompt: "A goa beach",
      generatedImageData: "https://provider.example.com/image.png",
      provider: "provider-x",
      clientRequestId: "req-123",
    },
    {
      insertMessage: insertMessage as any,
      uploadImage: uploadImage as any,
    },
  );

  assert(insertCalls.length === 2, "persistence inserts exactly two messages", `count=${insertCalls.length}`);
  assert(uploadCalls.length === 1, "persistence uploads exactly one generated image", `count=${uploadCalls.length}`);
  assert(
    insertCalls[0].content === buildImagePromptMessageContent("A goa beach"),
    "user prompt message is persisted with image-request wording",
    insertCalls[0].content,
  );
  assert(insertCalls[0].clientRequestId === "req-123", "user prompt preserves clientRequestId");
  assert(insertCalls[1].role === "assistant", "assistant message is persisted");
  assert(insertCalls[1].messageType === "image", "assistant message is marked as image");
  assert(
    insertCalls[1].imageUrl === "https://cdn.example.com/user/chat/generated.webp",
    "assistant message stores durable image URL",
    insertCalls[1].imageUrl,
  );
  assert(insertCalls[1].storagePath === "user/chat/generated.webp", "assistant message stores storage path");
  assert(insertCalls[1].fileSizeBytes === 12345, "assistant message stores file size metadata");
  assert(result.assistantMessage.message_type === "image", "result exposes assistant image metadata");
}

async function testFindExistingAssistantImageMessage(): Promise<void> {
  let lookupArgs: any = null;
  const existingMessage = {
    id: "assistant-1",
    role: "assistant" as const,
    content: "",
    created_at: new Date().toISOString(),
    client_request_id: "req-existing",
    message_type: "image",
    image_url: "https://cdn.example.com/existing.webp",
    storage_path: "user/chat/existing.webp",
    prompt: "Existing image",
    provider: "provider-y",
    file_size_bytes: 6789,
  };

  const found = await findExistingAssistantImageMessage(
    {},
    "chat-1",
    "req-existing",
    (async (_userDb: any, data: any) => {
      lookupArgs = { ...data };
      return { data: existingMessage, error: null };
    }) as any,
  );

  assert(lookupArgs?.role === "assistant", "assistant image lookup scopes to assistant role");
  assert(lookupArgs?.messageType === "image", "assistant image lookup scopes to image message type");
  assert(found?.image_url === existingMessage.image_url, "assistant image lookup returns persisted image message");
}

async function main(): Promise<void> {
  console.log("Running generated image persistence tests...");
  await testPersistGeneratedImageResult();
  await testFindExistingAssistantImageMessage();
  console.log("Generated image persistence tests passed.");
}

main().catch((error) => {
  console.error("Generated image persistence tests failed:", error);
  process.exit(1);
});
