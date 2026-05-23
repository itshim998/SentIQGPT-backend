import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const chatController = read("frontend/scripts/features/chat-controller.js");
const storageService = read("frontend/scripts/services/storage.js");
const apiClient = read("frontend/scripts/services/api.js");
const server = read("backend/server.ts");
const conversationService = read("backend/services/conversationService.ts");

function functionBlock(source: string, signature: string, nextSignature: string): string {
  const start = source.indexOf(signature);
  assert(start >= 0, `${signature} should exist`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert(end > start, `${nextSignature} should follow ${signature}`);
  return source.slice(start, end);
}

const startNewChatBlock = functionBlock(
  chatController,
  "async function startNewChat()",
  "function updateHtmlTitle",
);
assert.doesNotMatch(
  startNewChatBlock,
  /ensureRemoteConversationForChat\(/,
  "new authenticated chats must not create empty Supabase rows in the background",
);
assert.match(
  chatController,
  /id:\s*Storage\.generateId\(\)/,
  "authenticated placeholder chats should use the canonical local UUID from the start",
);
assert.doesNotMatch(
  chatController,
  /id:\s*`pending-\$\{Storage\.generateId\(\)\}`/,
  "pending-* chat ids would reintroduce the first-message create race",
);
assert.match(
  chatController,
  /function getCanonicalConversationIdForRequest/,
  "chat requests should derive a canonical UUID conversation id",
);
assert.match(
  chatController,
  /conversationId:\s*conversationIdForRequest \|\| null/,
  "deferred sync jobs should carry the canonical conversation id",
);
assert.match(
  chatController,
  /conversationId:\s*conversationIdForRequest,/,
  "live chat requests should carry the canonical conversation id",
);
assert.doesNotMatch(
  chatController,
  /conversationId:\s*isPlaceholderServerChat\(await Storage\.getChat\(targetChatId\)\) \? null : targetChatId/,
  "placeholder status should not suppress a valid canonical conversation id",
);
assert.match(
  chatController,
  /cleanupDuplicateBlankServerChats/,
  "strict blank duplicate cleanup should run after authenticated list hydration",
);
assert.match(
  chatController,
  /counts\.localCount > 0 \|\| counts\.serverCount !== 0/,
  "duplicate cleanup must skip any chat that may contain messages",
);

assert.match(
  storageService,
  /async function mergeChatMessages/,
  "storage should merge server messages instead of replacing local content blindly",
);
assert.match(
  storageService,
  /request:\$\{message\.role\}:\$\{messageType\}:\$\{clientRequestId\}/,
  "message merge keys should include clientRequestId and role",
);
assert.match(
  storageService,
  /incomingMessages\.length === 0 && existingMessages\.length > 0/,
  "empty remote hydration should preserve non-empty local messages",
);
assert.match(
  storageService,
  /isFirstMessageFallbackTitle/,
  "fallback first-message titles should not beat stronger summarized titles",
);

assert.match(
  apiClient,
  /async function createConversation\(title = "New Chat", conversationId = null\)/,
  "conversation create API should accept an optional client conversation UUID",
);
assert.match(
  apiClient,
  /requestedConversationId \? \{ conversationId: requestedConversationId \} : \{\}/,
  "conversation create API should send the optional UUID when present",
);

assert.match(
  conversationService,
  /id\?: string/,
  "createConversation service input should accept a client-generated id",
);
assert.match(
  conversationService,
  /\.\.\.\(data\.id \? \{ id: data\.id \} : \{\}\)/,
  "Supabase conversation inserts should use the client id when provided",
);
assert.match(
  conversationService,
  /message_count/,
  "conversation list rows should expose message_count metadata",
);
assert.match(
  conversationService,
  /first_user_message/,
  "conversation list rows should expose first user message previews",
);

assert.match(
  server,
  /resolveOrCreateConversationForRequest/,
  "backend routes should share idempotent resolve-or-create behavior",
);
assert.match(
  server,
  /createConversation\(userDb, \{ userId, title, id: conversationId \}\)/,
  "conversation creation should pass requested UUIDs into the service",
);
assert.match(
  server,
  /getOptionalUuid\(req\.body\?\.conversationId \|\| req\.body\?\.conversation_id/,
  "POST /api/conversations should accept conversationId",
);
assert.match(
  server,
  /requestedConversationId \|\| null,\s*requestedTitle/s,
  "chat sync should create missing requested conversations with the same client id",
);
assert.match(
  server,
  /function getUnavailableReplyReason/,
  "backend stream recovery should classify empty and generic unavailable replies",
);
assert.match(
  server,
  /async function recoverBufferedStreamText/,
  "backend stream recovery should use a shared buffered adapter fallback",
);
assert.match(
  server,
  /route:\s*"guest\.general"[\s\S]*reason:\s*"empty_stream"/,
  "guest general streams should recover empty completions",
);
assert.match(
  server,
  /route:\s*"stream\.fast"[\s\S]*reason:\s*"stream_error_before_first_token"/,
  "signed-in fast streams should recover pre-token failures once",
);
assert.match(
  server,
  /route:\s*"stream"[\s\S]*reason:\s*"empty_stream"/,
  "signed-in general streams should recover empty completions",
);
assert.match(
  server,
  /GENERIC_UNAVAILABLE_REPLY_PATTERN/,
  "backend should reject the generic unavailable assistant phrase during recovery",
);

console.log("PASS | Conversation sync state regression checks passed.");
