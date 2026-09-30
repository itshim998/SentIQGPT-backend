import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const chatController = read("frontend/scripts/features/chat-controller.js");
const storageService = read("frontend/scripts/services/storage.js");
const apiClient = read("frontend/scripts/services/api.js");
const server = read("backend/serverLegacy.ts");
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
  "async function startNewChat(options = {})",
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
  chatController,
  /function isConversationNotFoundError/,
  "frontend should classify stale backend conversation ids",
);
assert.match(
  chatController,
  /queueRemoteMissingChatRecovery[\s\S]*pending_server_sync: true[\s\S]*missing_remote_at/,
  "frontend should preserve local messages and mark missing remote chats for resync",
);
assert.match(
  chatController,
  /reconcileCachedServerChatsWithRemote[\s\S]*Storage\.deleteChat\(cachedChat\.id\)/,
  "frontend should prune stale empty cached server chats after a successful remote list",
);
assert.match(
  chatController,
  /renderLoadedChat\(remoteChat\.id \|\| chatId, remoteChat/,
  "remote hydration should render with the canonical chat id returned by the server",
);
assert.match(
  chatController,
  /function renderChatLoadFailure/,
  "older chat hydration failures should render a retry state instead of falling through to a blank view",
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
  storageService,
  /async function updateChatSyncState/,
  "storage should support scoped cache repair metadata for stale server chats",
);
assert.match(
  storageService,
  /missing_remote_at/,
  "storage should persist stale remote markers without clearing IndexedDB",
);
const getAllChatsBlock = functionBlock(
  storageService,
  "async function getAllChats()",
  "async function getLocalChats()",
);
assert.match(
  getAllChatsBlock,
  /\.sort\(compareChatsByActivity\)/,
  "cached chat lists must use the canonical activity comparator",
);
const serverActivityBlock = functionBlock(
  storageService,
  "function getServerChatActivityTimestamp",
  "function getChatActivityTimestamp",
);
assert.match(
  serverActivityBlock,
  /last_activity_at[\s\S]*last_message_at[\s\S]*updated[\s\S]*created/,
  "server chat ordering must prefer last activity, then last message, then cached update, then creation",
);
const compareChatsBlock = functionBlock(
  storageService,
  "export function compareChatsByActivity",
  "function touchChatActivity",
);
assert.match(
  compareChatsBlock,
  /getChatActivityTimestamp\(right\)[\s\S]*getChatActivityTimestamp\(left\)[\s\S]*getChatCreatedTimestamp\(right\)[\s\S]*localeCompare/,
  "chat activity comparator must sort newest activity first with stable tie-breaks",
);
const upsertServerChatBlock = functionBlock(
  storageService,
  "async function upsertServerChat",
  "async function updateChatSyncState",
);
assert.match(
  upsertServerChatBlock,
  /const activity = getNewestTimestampValue\(incomingActivity, existingActivity, created\)/,
  "server cache upserts must not downgrade a newer cached activity timestamp",
);
assert.match(
  upsertServerChatBlock,
  /updated:\s*activity[\s\S]*last_activity_at:\s*activity[\s\S]*last_message_at:/,
  "server cache upserts must persist canonical activity metadata",
);
const mergeChatMessagesBlock = functionBlock(
  storageService,
  "async function mergeChatMessages",
  "async function replaceChatMessages",
);
assert.match(
  mergeChatMessagesBlock,
  /touchChatActivity\(chat, lastMessageTimestamp\)/,
  "message hydration must update server activity from message timestamps instead of load time",
);
const pruneServerChatMessageCacheBlock = functionBlock(
  storageService,
  "async function pruneServerChatMessageCache",
  "async function updateChatTitle",
);
assert.match(
  pruneServerChatMessageCacheBlock,
  /keepIds\.has\(chat\.id\) \|\| chat\.pending_server_sync \|\| chat\.missing_remote_at/,
  "message-cache pruning must preserve current/recent, pending-sync, and missing-remote chats",
);
assert.match(
  pruneServerChatMessageCacheBlock,
  /chat\.messages = \[\][\s\S]*message_cache_status = "metadata-only"/,
  "message-cache pruning must keep metadata while dropping older full message payloads",
);
assert.match(
  pruneServerChatMessageCacheBlock,
  /cachedMessageCount = chat\.messages\.length[\s\S]*chat\.message_count =/,
  "message-cache pruning must preserve a visible message count before clearing cached messages",
);
assert.match(
  storageService,
  /pruneServerChatMessageCache, compareChatsByActivity/,
  "storage public surface must expose cache pruning and canonical ordering helpers",
);
const warmRecentChatCacheBlock = functionBlock(
  chatController,
  "async function warmRecentChatCache",
  "function normalizeDuplicateFingerprint",
);
assert.match(
  warmRecentChatCacheBlock,
  /filter\(\(chat\) => chat\?\.id && isVisibleChatListItem\(chat\)\)[\s\S]*slice\(0, RECENT_CHAT_WARM_LIMIT\)/,
  "recent local warming must target the newest visible five chats",
);
assert.match(
  warmRecentChatCacheBlock,
  /pruneChatMessageWarmCache\(recentChatIds\)/,
  "recent warming must prune older unprotected full-message caches",
);
const visibleChatListItemBlock = functionBlock(
  chatController,
  "function isVisibleChatListItem",
  "function titleLooksLikeFirstMessageFallback",
);
assert.match(
  visibleChatListItemBlock,
  /counts\.localCount > 0 \|\| \(counts\.serverCount !== null && counts\.serverCount > 0\)/,
  "empty authenticated chats must stay hidden until they have local or server messages",
);
assert.match(
  visibleChatListItemBlock,
  /first_user_message[\s\S]*last_message_at/,
  "older cached metadata with message evidence should remain visible even without full message cache",
);
const loadChatListBlock = functionBlock(
  chatController,
  "async function _loadChatListImpl",
  "function renderLoadedChat",
);
assert.match(
  loadChatListBlock,
  /const sidebarChats = isAuthenticatedSession\(\)[\s\S]*chats\.filter\(isVisibleChatListItem\)/,
  "sidebar rendering and search must filter hidden empty authenticated chats without reordering",
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
