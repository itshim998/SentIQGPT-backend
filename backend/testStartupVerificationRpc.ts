import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

const dbRouter = read("backend/dbRouter.ts");
const bootProfiler = read("backend/bootProfiler.ts");
const controlMigration = read("supabase/migrations/20260709130000_control_startup_verification_rpc.sql");
const dataMigration = read("supabase/migrations/20260709131000_data_shard_startup_verification_rpc.sql");

assert.match(dbRouter, /type StartupVerifierMode = "legacy" \| "rpc" \| "auto"/);
assert.match(dbRouter, /SENTIQ_STARTUP_VERIFIER/);
assert.match(dbRouter, /if \(!normalized\) return "auto"/, "startup verifier should default to auto mode");
assert.match(dbRouter, /verifyShardMigrationsLegacy/);
assert.match(dbRouter, /verifyShardMigrationsRpc/);
assert.match(dbRouter, /StartupVerifierRpcUnavailableError/);
assert.match(dbRouter, /startup-verifier\.rpc-unavailable\.fallback-legacy/);
assert.match(dbRouter, /parseStartupVerifierRpcResult/);
assert.match(dbRouter, /malformed startup verifier RPC response/);
assert.match(dbRouter, /verify_sentiq_control_startup/);
assert.match(dbRouter, /verify_sentiq_data_shard_startup/);
assert.match(dbRouter, /markDuration/);
assert.match(bootProfiler, /markDuration\(label: string, durationMs: number\)/);

for (const sql of [controlMigration, dataMigration]) {
  assert.match(sql, /returns jsonb/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = public, pg_temp/i);
  for (const field of ["ok", "failures", "timings", "group", "check", "code", "message", "elapsed_ms"]) {
    assert(sql.includes(`'${field}'`), `startup verifier migration includes ${field}`);
  }
  assert.match(sql, /revoke all on function public\.verify_sentiq_/i);
  assert.match(sql, /from public/i);
  assert.match(sql, /from anon/i);
  assert.match(sql, /from authenticated/i);
  assert.match(sql, /grant execute on function public\.verify_sentiq_/i);
  assert.match(sql, /to service_role/i);
}

assert.match(controlMigration, /RUN ON: Database 1 only/i);
assert.match(controlMigration, /create or replace function public\.verify_sentiq_control_startup\(p_probe_user_id uuid\)/i);
for (const token of [
  "live_capacity_leases",
  "live_sessions",
  "audio_started_at",
  "reserved_seconds",
  "used_seconds",
  "mark_live_session_started",
]) {
  assert(controlMigration.includes(token), `control startup verifier checks ${token}`);
}

assert.match(dataMigration, /RUN ON: Databases 2, 3, 4 only/i);
assert.match(dataMigration, /create or replace function public\.verify_sentiq_data_shard_startup/i);
assert.match(dataMigration, /p_verify_live boolean default false/i);
for (const group of ["core", "generated-files", "conversation", "memory", "source-retrieval", "live", "cleanup"]) {
  assert(dataMigration.includes(`'${group}'`), `data startup verifier includes ${group} group`);
}
for (const token of [
  "initialize_user_session",
  "get_user_conversation_count",
  "chat_images",
  "generated_files",
  "messages_generated_file_columns",
  "generated_files_private_columns",
  "conversation_turn_requests",
  "conversation_aliases",
  "resolve_conversation_for_turn",
  "list_user_conversations",
  "conversations_last_activity_at",
  "adjust_user_memory_usage",
  "repair_user_memory_usage",
  "users_user_memory_usage_bytes",
  "memories_backfill_columns",
  "source_documents",
  "source_chunks",
  "search_source_chunks",
  "deep_research_reports",
  "live_sessions_lifecycle",
  "mark_live_session_started",
  "usage_logs_delete",
  "users_delete",
]) {
  assert(dataMigration.includes(token), `data startup verifier checks ${token}`);
}

console.log("PASS | startup verification RPC rollout checks passed.");
