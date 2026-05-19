import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const migration = read("supabase/migrations/20260519120000_conversation_canonicalization.sql");
const server = read("backend/server.ts");
const storage = read("frontend/scripts/services/storage.js");
const chatController = read("frontend/scripts/features/chat-controller.js");
const packageJson = read("package.json");
const dbRouter = read("backend/dbRouter.ts");

assert.match(
  migration,
  /create table if not exists public\.conversation_turn_requests[\s\S]*primary key \(user_id, client_request_id\)/,
  "turn idempotency must be keyed by user_id + client_request_id",
);
assert.match(
  migration,
  /create table if not exists public\.conversation_aliases/,
  "merged duplicate ids must leave alias tombstones",
);
assert.match(
  migration,
  /create table if not exists public\.conversation_merge_audit/,
  "duplicate merges must be auditable",
);
assert.match(
  migration,
  /create or replace function public\.resolve_conversation_for_turn/,
  "database must expose atomic turn-to-conversation resolution",
);
assert.match(
  migration,
  /insert into public\.conversation_turn_requests[\s\S]*on conflict \(user_id, client_request_id\) do nothing/,
  "turn resolution must be race/idempotency safe",
);
assert.match(
  migration,
  /create or replace function public\.merge_duplicate_conversation/,
  "database must expose an atomic duplicate merge function",
);
assert.match(
  migration,
  /update public\.chat_images[\s\S]*set chat_id = p_canonical_conversation_id/,
  "duplicate merge must preserve image metadata",
);
assert.match(
  migration,
  /update public\.generated_files[\s\S]*set chat_id = p_canonical_conversation_id/,
  "duplicate merge must preserve generated file metadata",
);
assert.match(
  migration,
  /update public\.memories[\s\S]*set chat_id = p_canonical_conversation_id/,
  "duplicate merge must preserve chat-scoped memories",
);
assert.match(
  migration,
  /delete from public\.messages d[\s\S]*d\.client_request_id is not null[\s\S]*c\.client_request_id = d\.client_request_id/,
  "duplicate merge must dedupe messages by client_request_id before moving rows",
);

assert.match(
  server,
  /resolveConversationForTurn/,
  "chat routes must use the DB turn idempotency RPC",
);
assert.match(
  server,
  /resolveOrCreateConversationForRequest\([\s\S]*options: \{ clientRequestId\?: string \| null \}/,
  "shared conversation resolution must accept clientRequestId",
);
assert.match(
  server,
  /cleanupDuplicateConversationsForUser/,
  "GET /api/conversations must run bounded backend duplicate cleanup",
);
assert.match(
  server,
  /titleLooksLikeFirstMessageFallback\(conversation\.title \|\| "", conversation\.first_user_message \|\| ""\)/,
  "non-empty duplicate cleanup must require a fallback title match",
);
assert.match(
  server,
  /DUPLICATE_MERGE_WINDOW_MS = 24 \* 60 \* 60 \* 1000/,
  "duplicate cleanup must use the selected 24 hour guardrail",
);
assert.match(
  server,
  /res\.json\(\{ conversations, merged \}\)/,
  "conversation list responses must expose merge aliases to clients",
);
assert.match(
  server,
  /getOwnedConversationResolvingAliasOrThrow/,
  "message fetch must resolve stale duplicate ids through aliases",
);
assert.match(
  server,
  /canonicalConversationId: conversation\.id/,
  "message fetch must tell clients the canonical conversation id",
);
assert.match(
  server,
  /if \(alias\?\.canonical_conversation_id\)[\s\S]*aliased: true/,
  "DELETE on an alias must not delete the canonical conversation",
);
assert.match(
  server,
  /allowFallbackReplacement: true[\s\S]*replacementBasisMessage: userMessage[\s\S]*titleSource: generation\.source/,
  "Groq summarized titles must be allowed to replace first-message fallback titles",
);
assert.doesNotMatch(
  server,
  /persisted: sync\.persisted && executionProfile\.persistence\.blockOnAssistantWrite/,
  "fast stream sync must not report deferred solely because fast mode skips blocking",
);
assert.match(
  server,
  /if \(fullReply\) \{\s*await persistAssistantMessage\(fullReply\);\s*\}/,
  "fast stream must await chat-content persistence before final sync",
);

assert.match(
  storage,
  /async function setConversationAlias/,
  "local storage must persist conversation aliases",
);
assert.match(
  storage,
  /async function resolveConversationAlias/,
  "local storage must resolve stale conversation ids",
);
assert.match(
  chatController,
  /const conversationAliasCache = new Map\(\)/,
  "frontend must keep an in-memory alias cache for request ids",
);
assert.match(
  chatController,
  /applyConversationAliasesFromServer\(response\?\.merged\)/,
  "frontend must consume backend merge aliases from list responses",
);
assert.match(
  chatController,
  /await applyConversationAlias\(chatId, canonicalChatId\)/,
  "frontend must rewrite stale ids returned by message fetch",
);
assert.match(
  chatController,
  /if \(localChatId !== conversationId\) \{\s*await applyConversationAlias\(localChatId, conversationId\);/,
  "frontend sync reconciliation must collapse local duplicates onto canonical ids",
);

assert.match(
  dbRouter,
  /conversation_turn_requests/,
  "startup migration verification must check the turn idempotency table",
);
assert.match(
  dbRouter,
  /resolve_conversation_for_turn/,
  "startup migration verification must check the turn resolution RPC",
);
assert.match(
  packageJson,
  /"test:supabase-canonicalization"/,
  "package scripts must include the Supabase canonicalization regression test",
);

console.log("PASS | Supabase canonicalization regression checks passed.");
