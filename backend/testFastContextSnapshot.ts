import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildContextFast } from "./context/contextBuilder";
import {
  FAST_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  collectSourceDocumentIds,
  fetchFastContextSnapshot,
  mergeServerAuthoritativeMessages,
  normalizeFastContextSnapshot,
} from "./services/fastContextSnapshotService";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";

function snapshotPayload() {
  return {
    schema_version: FAST_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    conversation_id: CONVERSATION_ID,
    messages: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        role: "user",
        content: "Start the Atlas rollout.",
        created_at: "2026-08-04T17:00:00.000Z",
        client_request_id: "request-a",
        message_type: "text",
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        role: "assistant",
        content: "The API rollout is ready.",
        created_at: "2026-08-04T17:01:00.000Z",
        client_request_id: "request-a",
        message_type: "text",
      },
    ],
    message_cursor: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      created_at: "2026-08-04T17:01:00.000Z",
    },
    conversation_capsule: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      scope: "conversation",
      conversation_id: CONVERSATION_ID,
      content: "CONVERSATION-CAPSULE: API before client; keep minReplicas at zero.",
      source_message_count: 12,
      source_cursor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      version: 4,
      updated_at: "2026-08-04T17:02:00.000Z",
    },
    workspace_capsule: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      scope: "workspace",
      conversation_id: null,
      content: "WORKSPACE-CAPSULE: Atlas is the active rollout project.",
      source_message_count: 40,
      source_cursor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      version: 9,
      updated_at: "2026-08-04T17:03:00.000Z",
    },
    memories: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
        type: "project",
        summary: "ATLAS-MEMORY: Keep minReplicas at zero during the rollout.",
        importance: 9,
        scope: "chat",
        chat_id: CONVERSATION_ID,
        created_at: "2026-08-04T16:00:00.000Z",
        lexical_rank: 0.8,
      },
    ],
    source_documents: [
      {
        id: SOURCE_ID,
        conversation_id: CONVERSATION_ID,
        title: "Atlas rollout brief",
        original_filename: "atlas.pdf",
        mime_type: "application/pdf",
        source_type: "pdf",
        status: "ready",
        metadata: { analysis_id: "analysis-atlas" },
        created_at: "2026-08-04T15:00:00.000Z",
      },
    ],
    cursors: {
      message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      message_created_at: "2026-08-04T17:01:00.000Z",
      conversation_capsule_source_cursor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      conversation_capsule_version: 4,
      workspace_capsule_source_cursor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      workspace_capsule_version: 9,
    },
  };
}

async function main(): Promise<void> {
  const normalized = normalizeFastContextSnapshot(snapshotPayload());
  assert(normalized);
  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.conversationCapsule?.version, 4);
  assert.equal(normalized.workspaceCapsule?.version, 9);
  assert.equal(normalized.memories[0].lexicalRank, 0.8);
  assert.equal(normalized.sourceDocuments[0].id, SOURCE_ID);
  assert.equal(normalized.cursors.messageId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");

  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const userDb = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return { data: snapshotPayload(), error: null };
    },
    from: () => {
      throw new Error("Fast snapshot path must not issue an additional table query without file references.");
    },
  };
  const available = await fetchFastContextSnapshot({
    userDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    query: "What is the Atlas rollout decision?",
    clientRequestId: "current-request",
    sourceDocumentIds: [SOURCE_ID],
    timeoutMs: 50,
  });
  assert.equal(available.status, "available");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_fast_context_snapshot");
  assert.equal(calls[0].params.p_owner_user_id, USER_ID);
  assert.equal(calls[0].params.p_client_request_id, "current-request");
  assert.deepEqual(calls[0].params.p_source_document_ids, [SOURCE_ID]);

  const timedOut = await fetchFastContextSnapshot({
    userDb: { rpc: () => new Promise(() => undefined) },
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    query: "timeout",
    timeoutMs: 10,
  });
  assert.equal(timedOut.status, "timeout");
  assert(timedOut.elapsedMs < 100, "snapshot timeout must not hold the Fast request indefinitely");

  const degraded = await fetchFastContextSnapshot({
    userDb: { rpc: async () => ({ data: null, error: { code: "57014", message: "database degraded" } }) },
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    query: "degraded",
    timeoutMs: 50,
  });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.errorCode, "57014");

  const skipped = await fetchFastContextSnapshot({
    userDb,
    ownerUserId: "guest",
    conversationId: CONVERSATION_ID,
    query: "guest",
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(calls.length, 1, "guest requests must not call the snapshot RPC");

  const merged = mergeServerAuthoritativeMessages({
    canonicalMessages: normalized.messages,
    clientMessages: [
      { role: "user", content: "Start the Atlas rollout." },
      { role: "assistant", content: "Local optimistic assistant tail." },
    ],
    limit: 20,
  });
  assert.deepEqual(merged.map((message) => message.content), [
    "Start the Atlas rollout.",
    "The API rollout is ready.",
    "Local optimistic assistant tail.",
  ]);

  const currentRemoved = mergeServerAuthoritativeMessages({
    canonicalMessages: [
      ...normalized.messages,
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        role: "user",
        content: "What should we do next?",
        createdAt: "2026-08-04T17:04:00.000Z",
      },
    ],
    clientMessages: [],
    currentUserMessage: "What should we do next?",
  });
  assert(!currentRemoved.some((message) => message.content === "What should we do next?"));

  const noOverlap = mergeServerAuthoritativeMessages({
    canonicalMessages: normalized.messages,
    clientMessages: [{ role: "assistant", content: "Unverifiable stale browser history." }],
  });
  assert(!noOverlap.some((message) => message.content.includes("Unverifiable")),
    "server history must remain authoritative when the client hint has no cursor overlap");

  assert.deepEqual(collectSourceDocumentIds([
    { sourceDocumentId: SOURCE_ID },
    { source_document_id: SOURCE_ID },
    { document_id: "not-a-uuid" },
  ]), [SOURCE_ID]);

  const built = await buildContextFast({
    recent_messages: [
      { role: "user", content: "Start the Atlas rollout." },
      { role: "assistant", content: "Local optimistic assistant tail." },
    ],
    memories: [],
    userMessage: "What is the Atlas rollout decision?",
    userDb: userDb as any,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    clientRequestId: "current-request",
  }, userDb as any, USER_ID, { fastSnapshotTimeoutMs: 50 });
  assert.equal(built.fastContextSnapshot?.status, "available");
  assert.equal(built.fastContextSnapshot?.conversationCapsuleVersion, 4);
  assert.equal(built.fastContextSnapshot?.workspaceCapsuleVersion, 9);
  assert.equal(built.conversationCapsule?.includes("API before client"), true);
  assert.equal(built.workspaceCapsule?.includes("active rollout project"), true);
  assert(built.memories.some((memory) => memory.summary.includes("ATLAS-MEMORY")));
  assert(built.recentMessages.some((message) => message.content === "The API rollout is ready."),
    "canonical history must fill a browser-history gap");
  assert.equal(built.sourceDocumentIdentities?.[0].id, SOURCE_ID);
  assert.equal(calls.length, 2, "buildContextFast must use one snapshot RPC and no extra durable-context reads");

  const localFallback = await buildContextFast({
    recent_messages: [
      { role: "user", content: "LOCAL-FALLBACK-USER" },
      { role: "assistant", content: "LOCAL-FALLBACK-ASSISTANT" },
    ],
    userMessage: "Continue.",
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
  }, undefined, USER_ID, {
    fastSnapshotPromise: Promise.resolve({
      status: "timeout",
      elapsedMs: 10,
      timeoutMs: 10,
      errorCode: "snapshot_timeout",
    }),
  });
  assert.equal(localFallback.fastContextSnapshot?.status, "timeout");
  assert(localFallback.recentMessages.some((message) => message.content === "LOCAL-FALLBACK-ASSISTANT"));

  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/20260804180700_add_fast_context_snapshot.sql",
  );
  const migration = readFileSync(migrationPath, "utf8");
  assert(migration.includes("create or replace function public.get_fast_context_snapshot"));
  assert(migration.includes("language sql"));
  assert(migration.includes("stable"));
  assert(migration.includes("security invoker"));
  assert(migration.includes("messages_conversation_created_id_desc_idx"));
  assert(migration.includes("conversation.user_id = p_owner_user_id"));
  assert(migration.includes("message.client_request_id = nullif(btrim(p_client_request_id), '')"));
  assert(migration.includes("grant execute on function public.get_fast_context_snapshot"));
  const functionBody = migration.slice(
    migration.indexOf("create or replace function public.get_fast_context_snapshot"),
    migration.indexOf("revoke all on function public.get_fast_context_snapshot"),
  );
  assert(!/\b(insert|update|delete|call)\b/i.test(functionBody),
    "the Fast snapshot RPC must remain a stable read-only operation");

  console.log("Fast context snapshot Phase 2 tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
