import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const allowDestructive = process.env.SENTIQ_BILLING_TEST_DATABASE_ALLOW_DESTRUCTIVE === "true";
const databaseUrl = process.env.SENTIQ_BILLING_TEST_DATABASE_URL?.trim() ?? "";

if (!allowDestructive || !databaseUrl) {
  console.log(
    "Unified text full-rollout PostgreSQL gate skipped: set the explicitly disposable billing test database signals.",
  );
  process.exit(0);
}

const parsedUrl = new URL(databaseUrl);
const databaseName = parsedUrl.pathname.replace(/^\/+/, "").toLowerCase();
const safeHost = ["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname.toLowerCase());
if (!safeHost || !databaseName.includes("test")) {
  throw new Error("Refusing destructive rollout checks outside a localhost test database.");
}

const repoRoot = resolve(__dirname, "../..");
const migrations = [
  "supabase/migrations/20260604120000_billing_plans_usage_and_subscriptions.sql",
  "supabase/migrations/20260718120000_standard_lite_token_allowances.sql",
  "supabase/migrations/20260727120000_unified_text_tokens_v2.sql",
  "supabase/migrations/20260727180000_unified_text_tokens_v2_integrity.sql",
  "supabase/migrations/20260727183000_unified_text_tokens_v2_schema_compat.sql",
  "supabase/migrations/20260728100000_unified_text_tokens_v2_full_rollout_gate.sql",
  "supabase/migrations/20260728180000_unified_text_tokens_v2_pgcrypto_resolution.sql",
].map((path) => resolve(repoRoot, path));

function psqlArgs(extra: readonly string[]): string[] {
  return ["-X", databaseUrl, "-v", "ON_ERROR_STOP=1", ...extra];
}

function runSql(sql: string): string {
  const result = spawnSync("psql", psqlArgs(["-Atq", "-c", sql]), {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`PostgreSQL rollout-gate statement failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function applyMigration(path: string): void {
  const result = spawnSync("psql", psqlArgs(["-q", "-f", path]), {
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to apply disposable migration ${path}: ${result.stderr || result.stdout}`);
  }
}

function main(): void {
  runSql("drop schema if exists public cascade; create schema public; grant all on schema public to postgres, public;");
  for (const migration of migrations) applyMigration(migration);

  const baseVersion = runSql("select public.get_unified_text_tokens_v2_schema_version()");
  assert.equal(baseVersion, "20260727120000");
  const fullVersion = runSql("select public.get_unified_text_tokens_v2_full_rollout_schema_version()");
  assert.equal(fullVersion, "20260728180000");

  const gate = JSON.parse(runSql("select public.verify_unified_text_tokens_v2_rollout()::text"));
  assert.equal(gate.ready, true);
  assert.equal(gate.schema_version, "20260728180000");
  assert.equal(gate.base_schema_version, "20260727120000");
  assert.equal(gate.missing_count, 0);
  assert.deepEqual(gate.missing, []);

  const commitProbe = JSON.parse(runSql(`
    with reservation as (
      select public.reserve_unified_text_tokens_v2(
        '00000000-0000-0000-0000-000000001800'::uuid,
        null,
        'full-rollout-pgcrypto-resolution',
        'fast',
        256,
        256,
        '{"ttl_seconds":600}'::jsonb
      ) as value
    )
    select public.commit_unified_text_tokens_v2(
      (value ->> 'reservation_id')::uuid,
      value ->> 'request_id',
      1,
      '{"input_tokens":1,"output_tokens":1,"successful_model_calls":1,"usage_reported_calls":1}'::jsonb
    )::text
    from reservation
  `));
  assert.equal(commitProbe.committed, true);
  assert.equal(commitProbe.rollback_shadows_synced, true);

  const secondApply = migrations.slice(-1)[0];
  applyMigration(secondApply);
  const repeated = JSON.parse(runSql("select public.verify_unified_text_tokens_v2_rollout()::text"));
  assert.equal(repeated.ready, true);
  assert.equal(repeated.missing_count, 0);

  console.log("Unified text full-rollout PostgreSQL migration gate passed.");
}

main();
