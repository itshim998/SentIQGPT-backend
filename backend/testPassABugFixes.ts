import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildHttpErrorResponse, HttpError } from "./httpErrors";
import { getOptionalUuid, getRequiredUuid } from "./validation/uuid";
import {
  isPrivateOrInternalAddress,
  isPrivateOrInternalHost,
} from "./tools/webSearch/contentExtractor";
import { validateFileUpload } from "./ai/FileIngestionHandler";
import { readFrontendSources } from "./frontendSource";

const root = path.resolve(__dirname, "..");
const validUuid = "123e4567-e89b-12d3-a456-426614174000";

{
  assert.equal(getRequiredUuid(` ${validUuid} `, "Conversation id"), validUuid);
  assert.equal(getOptionalUuid("guest-local-123", "conversationId", { ignoreInvalid: true }), undefined);
  assert.throws(
    () => getRequiredUuid("guest-local-123", "Conversation id"),
    (error) => {
      assert(error instanceof HttpError);
      const response = buildHttpErrorResponse(error);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: "Conversation id must be a valid UUID.",
        code: "invalid_uuid",
      });
      return true;
    },
  );
}

{
  assert.equal(isPrivateOrInternalAddress("172.15.0.1"), false, "public 172.15/16 must be allowed");
  assert.equal(isPrivateOrInternalAddress("172.32.0.1"), false, "public 172.32/16 must be allowed");
  assert.equal(isPrivateOrInternalAddress("172.16.0.1"), true, "private 172.16/12 must be blocked");
  assert.equal(isPrivateOrInternalAddress("172.31.255.255"), true, "private 172.16/12 upper range must be blocked");
  assert.equal(isPrivateOrInternalAddress("10.0.0.1"), true);
  assert.equal(isPrivateOrInternalAddress("192.168.1.1"), true);
  assert.equal(isPrivateOrInternalAddress("127.0.0.1"), true);
  assert.equal(isPrivateOrInternalAddress("169.254.169.254"), true);
  assert.equal(isPrivateOrInternalAddress("::1"), true);
  assert.equal(isPrivateOrInternalAddress("fe80::1"), true);
  assert.equal(isPrivateOrInternalAddress("fc00::1"), true);
  assert.equal(isPrivateOrInternalAddress("2001:4860:4860::8888"), false);
  assert.equal(isPrivateOrInternalHost("localhost"), true);
  assert.equal(isPrivateOrInternalHost("metadata.google.internal"), true);
  assert.equal(isPrivateOrInternalHost("example.local"), true);
}

{
  const migration = fs.readFileSync(
    path.join(root, "supabase", "migrations", "20260506120000_serialize_conversation_limit.sql"),
    "utf8",
  );
  const lockIndex = migration.indexOf("for update");
  const countIndex = migration.indexOf("select count(*) into conversation_count");
  assert(lockIndex > 0, "conversation-limit migration should lock the user row");
  assert(countIndex > lockIndex, "conversation count must happen after the per-user lock");
  assert(migration.includes("perform public.ensure_user_exists(new.user_id)"));
}

{
  const frontendDirEntries = fs
    .readdirSync(path.join(root, "frontend"))
    .filter((entry) => entry !== "backup_monolithic_index.html")
    .sort();
  assert.deepEqual(frontendDirEntries, [".htaccess", "index.html", "scripts", "styles"], "frontend directory should contain modular static assets");

  const indexHtml = readFrontendSources(root).combined;
  const maybeGenerateTitleStart = indexHtml.indexOf("async function maybeGenerateTitle");
  const maybeGenerateTitleEnd = indexHtml.indexOf("function scrollToBottom", maybeGenerateTitleStart);
  assert(maybeGenerateTitleStart > 0 && maybeGenerateTitleEnd > maybeGenerateTitleStart);
  const maybeGenerateTitleBlock = indexHtml.slice(maybeGenerateTitleStart, maybeGenerateTitleEnd);
  assert(maybeGenerateTitleBlock.includes("pendingTitleSync: false"));
  assert(!maybeGenerateTitleBlock.includes("queueSyncJob("), "auto-title should not enqueue redundant title patch");
  assert(!maybeGenerateTitleBlock.includes("SYNC_JOB_TYPES.chatTitle"), "auto-title should trust server persistence");
  assert(indexHtml.includes("function resolveChatImageMimeType(file)"), "frontend should normalize chat image MIME types");
  assert(indexHtml.includes('name.endsWith(".png")'), "PNG attachments should work when MIME is generic");
  assert(indexHtml.includes('name.endsWith(".jpg") || name.endsWith(".jpeg")'), "JPEG attachments should work when MIME is generic");
  assert(indexHtml.includes('name.endsWith(".webp")'), "WEBP attachments should work when MIME is generic");
}

{
  const server = fs.readFileSync(path.join(root, "backend", "server.ts"), "utf8");
  assert(server.includes("getOptionalUuid(parsed.data.conversationId, \"conversationId\", {\n      ignoreInvalid: isGuest"));
  assert(server.includes("const conversationId = getOptionalUuid(parsed.data.conversationId, \"conversationId\") || \"\""));
  assert(server.includes("const chatId = getRequiredUuid(req.params.chatId, \"chatId\")"));
  assert(server.includes("const selectionConversationId = getOptionalUuid(parsed.data.conversationId, \"conversationId\")"));
  const uploadRouteStart = server.indexOf('"/api/files/upload"');
  const uploadRouteBlock = server.slice(uploadRouteStart, server.indexOf("// ===============================", uploadRouteStart + 1));
  assert(uploadRouteBlock.includes("verifyJWT({ allowGuest: true })"), "file upload route should allow guest auth resolution");
  assert(uploadRouteBlock.includes("const { userId, isGuest } = await getRequestIdentity(req);"), "file upload should resolve guest identity");
  assert(uploadRouteBlock.includes("userId: isGuest ? undefined : userId"), "guest file uploads should not call signed-in vision as guest");
  assert(uploadRouteBlock.includes("getFileSessionKey(req, userId, isGuest)"), "guest file sessions should be IP-scoped");
}

{
  assert.deepEqual(validateFileUpload("application/pdf", 128, "report.pdf"), { valid: true, type: "pdf" });
  assert.deepEqual(validateFileUpload("application/octet-stream", 128, "report.pdf"), { valid: true, type: "pdf" });
  assert.deepEqual(validateFileUpload("", 128, "diagram.PNG"), { valid: true, type: "image" });
  assert.deepEqual(validateFileUpload("binary/octet-stream", 128, "photo.jpeg"), { valid: true, type: "image" });
  assert.deepEqual(validateFileUpload("application/octet-stream", 128, "notes.py"), { valid: true, type: "txt" });
  assert.equal(validateFileUpload("application/octet-stream", 128, "archive.zip").valid, false);
}

console.log("PASS | Pass A bug-fix regression tests passed.");
