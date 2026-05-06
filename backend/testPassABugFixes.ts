import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildHttpErrorResponse, HttpError } from "./httpErrors";
import { getOptionalUuid, getRequiredUuid } from "./validation/uuid";
import {
  isPrivateOrInternalAddress,
  isPrivateOrInternalHost,
} from "./tools/webSearch/contentExtractor";

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
  const frontendDirEntries = fs.readdirSync(path.join(root, "frontend")).sort();
  assert.deepEqual(frontendDirEntries, ["index.html"], "frontend directory should contain only index.html");

  const indexHtml = fs.readFileSync(path.join(root, "frontend", "index.html"), "utf8");
  const maybeGenerateTitleStart = indexHtml.indexOf("async function maybeGenerateTitle");
  const maybeGenerateTitleEnd = indexHtml.indexOf("function scrollToBottom", maybeGenerateTitleStart);
  assert(maybeGenerateTitleStart > 0 && maybeGenerateTitleEnd > maybeGenerateTitleStart);
  const maybeGenerateTitleBlock = indexHtml.slice(maybeGenerateTitleStart, maybeGenerateTitleEnd);
  assert(maybeGenerateTitleBlock.includes("pendingTitleSync: false"));
  assert(!maybeGenerateTitleBlock.includes("queueSyncJob("), "auto-title should not enqueue redundant title patch");
  assert(!maybeGenerateTitleBlock.includes("SYNC_JOB_TYPES.chatTitle"), "auto-title should trust server persistence");
}

{
  const server = fs.readFileSync(path.join(root, "backend", "server.ts"), "utf8");
  assert(server.includes("getOptionalUuid(parsed.data.conversationId, \"conversationId\", {\n      ignoreInvalid: isGuest"));
  assert(server.includes("const conversationId = getOptionalUuid(parsed.data.conversationId, \"conversationId\") || \"\""));
  assert(server.includes("const chatId = getRequiredUuid(req.params.chatId, \"chatId\")"));
  assert(server.includes("const selectionConversationId = getOptionalUuid(parsed.data.conversationId, \"conversationId\")"));
}

console.log("PASS | Pass A bug-fix regression tests passed.");
