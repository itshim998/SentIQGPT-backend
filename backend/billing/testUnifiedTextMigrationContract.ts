import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const migrationPath = resolve(
  repoRoot,
  "supabase/migrations/20260727120000_unified_text_tokens_v2.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const integrityMigration = readFileSync(
  resolve(repoRoot, "supabase/migrations/20260727180000_unified_text_tokens_v2_integrity.sql"),
  "utf8",
);
const schemaCompatMigration = readFileSync(
  resolve(repoRoot, "supabase/migrations/20260727183000_unified_text_tokens_v2_schema_compat.sql"),
  "utf8",
);
const pgcryptoResolutionMigration = readFileSync(
  resolve(repoRoot, "supabase/migrations/20260728180000_unified_text_tokens_v2_pgcrypto_resolution.sql"),
  "utf8",
);
const v1Migration = readFileSync(
  resolve(repoRoot, "supabase/migrations/20260718120000_standard_lite_token_allowances.sql"),
  "utf8",
);
const dbRouter = readFileSync(resolve(repoRoot, "backend/dbRouter.ts"), "utf8");
const server = readFileSync(resolve(repoRoot, "backend/server.ts"), "utf8");

assert.match(migration, /create table if not exists public\.unified_text_reservations_v2/i);
assert.match(migration, /create table if not exists public\.unified_text_usage_events_v2/i);
assert.match(migration, /check \(\(user_id is not null\) <> \(anonymous_key_hash is not null\)\)/i);
assert.match(migration, /policy_version = 'unified-text-tokens-v2'/i);
assert.match(migration, /v_limit_tokens constant integer := 50000/i);
assert.match(migration, /v_window_seconds constant integer := 18000/i);
assert.match(migration, /v_fast_reserve_tokens constant integer := 10000/i);
assert.match(migration, /execution_mode in \('fast', 'intuitive'\)/i);
assert.match(migration, /pg_advisory_xact_lock/i);
assert.match(migration, /hashtextextended\(\s*'sentiq:quota:' \|\| v_policy_version/i);
assert.match(migration, /reservation_expires_at <= now\(\)/i);
assert.match(migration, /least\(p_requested_tokens, v_maximum_reservable\)/i);
assert.match(migration, /v_remaining_tokens - v_fast_reserve_tokens/i);
assert.match(migration, /created_at >= now\(\) - make_interval\(secs => v_window_seconds\)/i);
assert.match(migration, /created_at \+ make_interval\(secs => v_window_seconds\) as recovers_at/i);
assert.match(migration, /min\(recovers_at\)/i);
assert.match(migration, /max\(recovers_at\)/i);
assert.match(migration, /feature in \('premium_text', 'lite_text'\)/i);
assert.match(migration, /metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'/i);
assert.match(migration, /unified_text_v2_rollback_shadow/i);
assert.match(migration, /rollback_shadow_v1_standard_tokens/i);
assert.match(migration, /usage_overrun_tokens/i);
assert.match(migration, /fast_reserve_breach_tokens/i);
assert.match(migration, /for update/i);
assert.match(migration, /v_safe_metadata,\s*now\(\)/i);
assert.match(migration, /security definer/i);
assert.match(migration, /set search_path = public, pg_temp/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /revoke all .* from public, anon, authenticated/i);
assert.match(migration, /grant execute .* to service_role/i);
assert.doesNotMatch(migration, /drop table|truncate table|delete from public\.usage_events/i);

assert.match(integrityMigration, /sync_unified_text_v2_rollback_shadows/i);
assert.match(integrityMigration, /unified_text_v2_rollback_shadow_class', 'standard_gate'/i);
assert.match(integrityMigration, /unified_text_v2_rollback_shadow_class', 'lite_usage'/i);
assert.match(integrityMigration, /feature,\s*units[\s\S]*?'premium_text'/i);
assert.match(integrityMigration, /feature,\s*units[\s\S]*?'lite_text'/i);
assert.match(integrityMigration, /v_late_settlement :=/i);
assert.match(integrityMigration, /v_late_capacity_overrun_tokens/i);
assert.match(integrityMigration, /v_reservation\.status = 'expired'/i);
assert.match(integrityMigration, /late_settlement/i);
assert.match(integrityMigration, /rollback_shadow_v1_lite_tokens/i);
assert.match(integrityMigration, /on conflict \(request_id\) where request_id is not null do update/i);
assert.match(integrityMigration, /security definer/i);
assert.match(integrityMigration, /set search_path = public, pg_temp/i);
assert.doesNotMatch(integrityMigration, /drop table|truncate table/i);

assert.match(schemaCompatMigration, /select '20260727120000'::text/i);
assert.match(schemaCompatMigration, /get_unified_text_tokens_v2_schema_version/i);
assert.match(
  pgcryptoResolutionMigration,
  /alter function public\.sync_unified_text_v2_rollback_shadows\(uuid\)\s+set search_path = public, extensions, pg_temp/i,
);
assert.match(pgcryptoResolutionMigration, /digest\('sentiq-unified-text-readiness', 'sha256'\)/i);
assert.match(pgcryptoResolutionMigration, /select '20260728180000'::text/i);
assert.match(pgcryptoResolutionMigration, /extensions_search_path/i);
assert.doesNotMatch(pgcryptoResolutionMigration, /drop table|truncate table|delete from/i);
assert.match(v1Migration, /standard-lite-tokens-v1/);
assert.doesNotMatch(v1Migration, /unified-text-tokens-v2/);
assert.match(dbRouter, /get_unified_text_tokens_v2_schema_version/);
assert.match(dbRouter, /20260727120000/);
assert.match(server, /quota_type:\s*quotaPayload\.type/);

console.log("Unified text-token V2 migration contract checks passed.");
