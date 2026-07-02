import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ContextCapsuleService,
  type ContextCapsuleRow,
  type ContextCapsuleWriteInput,
  type ContextCapsuleWriteResult,
} from "./services/contextCapsuleService";
import type { ConversationMessageRow } from "./services/conversationService";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-02T00:00:00.000Z";
const userDb = { test: true };

function capsule(overrides: Partial<ContextCapsuleRow> = {}): ContextCapsuleRow {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    owner_user_id: USER_ID,
    scope: "conversation",
    conversation_id: CONVERSATION_ID,
    content: "Initial capsule",
    source_message_count: 0,
    source_cursor: null,
    version: 1,
    updated_at: NOW,
    created_at: NOW,
    metadata: {},
    ...overrides,
  };
}

function messages(count: number, marker = "turn"): ConversationMessageRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${marker}-${index}`,
    created_at: NOW,
  }));
}

async function testMigrationShape(): Promise<void> {
  const migrationPath = path.resolve("supabase/migrations/20260702120000_add_context_capsules.sql");
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /Database 2, 3, 4 only/i, "migration is explicitly shard-only");
  assert.match(sql, /create table if not exists public\.context_capsules/i);
  for (const column of [
    "owner_user_id",
    "scope",
    "conversation_id",
    "content",
    "source_message_count",
    "source_cursor",
    "version",
    "updated_at",
    "created_at",
    "metadata",
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"), `migration includes ${column}`);
  }
  assert.match(sql, /context_capsules_one_conversation_capsule[\s\S]*where scope = 'conversation'/i);
  assert.match(sql, /context_capsules_one_workspace_capsule[\s\S]*where scope = 'workspace'/i);
  assert.match(sql, /foreign key \(conversation_id, owner_user_id\)[\s\S]*references public\.conversations\(id, user_id\)/i);
  assert.match(sql, /alter table public\.context_capsules enable row level security/i);
  assert.match(sql, /owner_user_id = auth\.uid\(\)/i);
  assert.match(sql, /revoke all on table public\.context_capsules from anon/i);
}

async function testCompareAndSwap(): Promise<void> {
  let stored: ContextCapsuleRow | undefined;
  const writeCapsuleCas = async (input: ContextCapsuleWriteInput): Promise<ContextCapsuleWriteResult> => {
    const actualVersion = stored?.version ?? 0;
    if (actualVersion !== input.expectedVersion) return { status: "conflict" };
    stored = capsule({
      id: stored?.id ?? "00000000-0000-4000-8000-000000000003",
      scope: input.scope,
      conversation_id: input.scope === "conversation" ? input.conversationId ?? null : null,
      content: input.content,
      source_message_count: input.sourceMessageCount,
      source_cursor: input.sourceCursor ?? null,
      version: actualVersion + 1,
      metadata: input.metadata ?? {},
    });
    return { status: "written", capsule: stored };
  };
  const service = new ContextCapsuleService({ writeCapsuleCas });
  const base = {
    userDb,
    ownerUserId: USER_ID,
    scope: "conversation" as const,
    conversationId: CONVERSATION_ID,
    sourceMessageCount: 8,
  };
  const created = await service.updateWithVersion({ ...base, content: "version one", expectedVersion: 0 });
  assert.equal(created.status, "written");
  const updated = await service.updateWithVersion({ ...base, content: "version two", expectedVersion: 1 });
  assert.equal(updated.status, "written");
  const stale = await service.updateWithVersion({ ...base, content: "stale overwrite", expectedVersion: 1 });
  assert.equal(stale.status, "conflict", "stale concurrent writer loses CAS");
  assert.equal(stored?.content, "version two", "newer capsule cannot be overwritten by stale content");
  assert.equal(stored?.version, 2);
}

async function testCapsuleReads(): Promise<void> {
  const conversation = capsule({ content: "Conversation read marker" });
  const workspace = capsule({
    id: "00000000-0000-4000-8000-000000000004",
    scope: "workspace",
    conversation_id: null,
    content: "Workspace read marker",
  });
  const service = new ContextCapsuleService({
    readCapsule: async ({ scope }) => scope === "conversation" ? conversation : workspace,
  });
  const pair = await service.readCapsules({
    userDb,
    ownerUserId: USER_ID,
    conversationId: CONVERSATION_ID,
  });
  assert.equal(pair.conversation?.content, "Conversation read marker");
  assert.equal(pair.workspace?.content, "Workspace read marker");
  assert.equal(service.peekCachedCapsules(USER_ID, CONVERSATION_ID).workspace?.version, 1, "successful reads warm Fast-path cache");
}

async function testAsyncRefreshAndThresholds(): Promise<void> {
  let releaseSummary: ((value: string) => void) | undefined;
  let writes = 0;
  let generated = 0;
  const service = new ContextCapsuleService({
    readCapsule: async () => undefined,
    listMessages: async () => messages(8),
    listConversationCapsules: async () => [],
    listDurableMemories: async () => [],
    generateSummary: async () => {
      generated += 1;
      return new Promise<string>((resolve) => {
        releaseSummary = resolve;
      });
    },
    writeCapsuleCas: async (input) => {
      writes += 1;
      return {
        status: "written",
        capsule: capsule({
          content: input.content,
          source_message_count: input.sourceMessageCount,
          source_cursor: input.sourceCursor ?? null,
          version: 1,
        }),
      };
    },
  });

  assert.equal(service.scheduleRefresh({ userDb, ownerUserId: USER_ID, conversationId: CONVERSATION_ID }), true);
  assert.equal(writes, 0, "scheduling returns before capsule generation or persistence");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(generated, 1, "background refresh starts asynchronously");
  assert.equal(writes, 0, "main request is not waiting for summary completion");
  assert(releaseSummary, "summary generator should be pending");
  releaseSummary("Asynchronous conversation capsule");
  await service.waitForScheduledRefreshesForTests();
  assert.equal(writes, 1);

  let shortGenerated = 0;
  const belowThreshold = new ContextCapsuleService({
    readCapsule: async () => undefined,
    listMessages: async () => messages(7),
    generateSummary: async () => {
      shortGenerated += 1;
      return "should not run";
    },
  });
  assert.equal(belowThreshold.scheduleRefresh({ userDb, ownerUserId: USER_ID, conversationId: CONVERSATION_ID }), true);
  await belowThreshold.waitForScheduledRefreshesForTests();
  assert.equal(shortGenerated, 0, "small unsummarized tails do not trigger generation");

  let tokenThresholdGenerated = 0;
  const tokenThreshold = new ContextCapsuleService({
    readCapsule: async () => undefined,
    listMessages: async () => messages(1).map((message) => ({
      ...message,
      content: Array.from({ length: 6_500 }, () => "substantial").join(" "),
    })),
    listConversationCapsules: async () => [],
    listDurableMemories: async () => [],
    generateSummary: async () => {
      tokenThresholdGenerated += 1;
      return "Token threshold capsule";
    },
    writeCapsuleCas: async (input) => ({
      status: "written",
      capsule: capsule({
        content: input.content,
        source_message_count: input.sourceMessageCount,
        source_cursor: input.sourceCursor ?? null,
      }),
    }),
  });
  tokenThreshold.scheduleRefresh({ userDb, ownerUserId: USER_ID, conversationId: CONVERSATION_ID });
  await tokenThreshold.waitForScheduledRefreshesForTests();
  assert.equal(tokenThresholdGenerated, 1, "large token growth refreshes even below eight messages");
}

async function testWorkspaceRefreshUsesCapsulesAndMemories(): Promise<void> {
  const generationPrompts: string[] = [];
  const writes: ContextCapsuleWriteInput[] = [];
  const newConversationCapsule = capsule({ version: 4, content: "COMPACT PROJECT ALPHA DECISIONS" });
  const service = new ContextCapsuleService({
    readCapsule: async () => undefined,
    listMessages: async () => messages(8, "RAW-TRANSCRIPT-MARKER"),
    listConversationCapsules: async () => [newConversationCapsule],
    listDurableMemories: async () => [{ type: "project", summary: "DURABLE MEMORY MARKER", importance: 9 }],
    generateSummary: async (prompt) => {
      generationPrompts.push(prompt);
      return generationPrompts.length === 1
        ? "COMPACT PROJECT ALPHA DECISIONS"
        : "WORKSPACE PROJECT ALPHA";
    },
    writeCapsuleCas: async (input) => {
      writes.push(input);
      return {
        status: "written",
        capsule: capsule({
          scope: input.scope,
          conversation_id: input.scope === "conversation" ? input.conversationId ?? null : null,
          content: input.content,
          source_message_count: input.sourceMessageCount,
          source_cursor: input.sourceCursor ?? null,
          version: 1,
          metadata: input.metadata ?? {},
        }),
      };
    },
  });
  service.scheduleRefresh({ userDb, ownerUserId: USER_ID, conversationId: CONVERSATION_ID });
  await service.waitForScheduledRefreshesForTests();
  assert.equal(generationPrompts.length, 2, "workspace refresh follows several capsule version updates");
  const workspacePrompt = generationPrompts[1];
  assert(workspacePrompt.includes("COMPACT PROJECT ALPHA DECISIONS"));
  assert(workspacePrompt.includes("DURABLE MEMORY MARKER"));
  assert(!workspacePrompt.includes("RAW-TRANSCRIPT-MARKER"), "workspace generation never receives raw chat history");
  assert.equal(writes[1]?.scope, "workspace");
}

async function testGuestNoWrite(): Promise<void> {
  let writes = 0;
  const service = new ContextCapsuleService({
    writeCapsuleCas: async () => {
      writes += 1;
      return { status: "conflict" };
    },
  });
  assert.equal(service.scheduleRefresh({ userDb, ownerUserId: "guest", conversationId: CONVERSATION_ID }), false);
  const direct = await service.updateWithVersion({
    userDb,
    ownerUserId: "guest-session",
    scope: "conversation",
    conversationId: CONVERSATION_ID,
    content: "must not persist",
    sourceMessageCount: 8,
    expectedVersion: 0,
  });
  assert.equal(direct.status, "conflict");
  assert.equal(writes, 0, "guest capsules never reach the database writer");
}

async function main(): Promise<void> {
  await testMigrationShape();
  await testCompareAndSwap();
  await testCapsuleReads();
  await testAsyncRefreshAndThresholds();
  await testWorkspaceRefreshUsesCapsulesAndMemories();
  await testGuestNoWrite();
  console.log("Context capsule Phase 3 tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
