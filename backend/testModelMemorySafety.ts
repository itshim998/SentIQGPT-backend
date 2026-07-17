import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { insertAutomaticMemoryOnce } from "./services/memoryService";

async function main(): Promise<void> {
  const migration = readFileSync(
    "supabase/migrations/20260715120000_automatic_memory_idempotency.sql",
    "utf8",
  );
  assert.match(migration, /automatic_idempotency_key text null/i);
  assert.match(migration, /unique index[\s\S]*\(user_id, automatic_idempotency_key\)[\s\S]*where automatic_idempotency_key is not null/i);
  assert.match(migration, /from public\.users[\s\S]*for update/i, "RPC must serialize writes per user");
  assert.ok(migration.indexOf("automatic_idempotency_key = p_automatic_idempotency_key") < migration.indexOf("insert into public.memories"));
  assert.match(migration, /update public\.users[\s\S]*user_memory_usage_bytes/i, "usage increments in the insertion transaction");
  assert.match(migration, /grant execute[\s\S]*insert_automatic_memory_once[\s\S]*to service_role/i);
  assert.match(migration, /get_automatic_memory_idempotency_schema_version/);

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fakeDb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        data: [{
          id: "memory-1",
          user_id: args.p_user_id,
          type: args.p_type,
          summary: args.p_summary,
          importance: args.p_importance,
          scope: args.p_scope,
          chat_id: args.p_chat_id,
          created_at: "2026-07-15T00:00:00.000Z",
          deduplicated: true,
        }],
        error: null,
      };
    },
  };
  const result = await insertAutomaticMemoryOnce(fakeDb, {
    userId: "11111111-1111-1111-1111-111111111111",
    type: "identity",
    summary: "my name is Mira.",
    importance: 9,
    scope: "global",
    automaticIdempotencyKey: "a".repeat(64),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "insert_automatic_memory_once");
  assert.equal(calls[0]?.args.p_automatic_idempotency_key, "a".repeat(64));
  assert.equal(result.data?.deduplicated, true);

  const executor = readFileSync("backend/orchestrator/toolExecutor.ts", "utf8");
  assert.match(executor, /executeMemory: \(_content, type, scope\)/, "model content must be ignored");
  assert.match(executor, /resolveAutomaticMemoryUpdate/, "scope and missing category defaults stay server-controlled");
  assert.match(executor, /Object\.defineProperty\(memory, "automatic_idempotency_key"/);
  assert.match(executor, /enumerable: false/);
  const server = readFileSync("backend/server.ts", "utf8");
  assert.ok((server.match(/insertAutomaticMemoryOrThrow/g) ?? []).length >= 3, "buffered and streaming writes use the automatic RPC helper");

  console.log("Automatic memory authorization and idempotency checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
