import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const migrationPath = resolve(
  repoRoot,
  "supabase/migrations/20260801091500_plan_tier_image_policy.sql",
);
const migration = readFileSync(migrationPath, "utf8");

assert.match(migration, /RUN ON: Auth\/control database only \(Database 1 \/ SUPABASE_URL_1\)/i);
assert.match(migration, /DO NOT RUN ON: Data shards 2, 3, or 4/i);
assert.match(migration, /to_regclass\('public\.billing_plans'\)/i);
assert.match(migration, /'free'::text, 2::integer, 86400::integer/i);
assert.match(migration, /'student_core'::text, 4::integer, 43200::integer/i);
assert.match(migration, /'premium'::text, 8::integer, 43200::integer/i);
assert.match(migration, /'pro'::text, 16::integer, 43200::integer/i);
assert.match(migration, /jsonb_set/i);
assert.match(migration, /matching_plan_count <> 4/i);
assert.doesNotMatch(migration, /drop table|truncate table|delete from/i);

function runPsql(args: readonly string[], input?: string): string {
  const databaseUrl = process.env.SENTIQ_BILLING_TEST_DATABASE_URL?.trim();
  assert(databaseUrl, "SENTIQ_BILLING_TEST_DATABASE_URL is required for the migration integration check");
  assert.equal(
    process.env.SENTIQ_BILLING_TEST_DATABASE_ALLOW_DESTRUCTIVE,
    "true",
    "destructive billing migration test opt-in is required",
  );
  const result = spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args],
    {
      encoding: "utf8",
      input,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function runIntegrationCheck(): void {
  runPsql(["-q"], `
    drop table if exists public.billing_plans cascade;
    create table public.billing_plans (
      code text primary key,
      entitlements jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    insert into public.billing_plans(code, entitlements) values
      ('free', '{"marker":"preserve","quotas":{"other":{"limit":9}}}'::jsonb),
      ('student_core', '{"marker":"preserve","quotas":{"other":{"limit":9}}}'::jsonb),
      ('premium', '{"marker":"preserve","quotas":{"other":{"limit":9}}}'::jsonb),
      ('pro', '{"marker":"preserve","quotas":{"other":{"limit":9}}}'::jsonb);
  `);

  try {
    runPsql(["-q", "-f", migrationPath]);
    const rows = runPsql([
      "-A",
      "-t",
      "-F", "|",
      "-c",
      `select
         code,
         entitlements #>> '{quotas,image_generation,limit}',
         entitlements #>> '{quotas,image_generation,window_seconds}',
         entitlements #>> '{quotas,image_generation,label}',
         entitlements #>> '{quotas,image_generation,unit}',
         entitlements ->> 'marker',
         entitlements #>> '{quotas,other,limit}'
       from public.billing_plans
       order by case code
         when 'free' then 1
         when 'student_core' then 2
         when 'premium' then 3
         when 'pro' then 4
       end`,
    ]).split("\n");

    assert.deepEqual(rows, [
      "free|2|86400|Images|count|preserve|9",
      "student_core|4|43200|Images|count|preserve|9",
      "premium|8|43200|Images|count|preserve|9",
      "pro|16|43200|Images|count|preserve|9",
    ]);

    // Idempotency: applying the migration twice must retain the same policy.
    runPsql(["-q", "-f", migrationPath]);
  } finally {
    runPsql(["-q", "-c", "drop table if exists public.billing_plans cascade;"]);
  }
}

runIntegrationCheck();
console.log("Auth-only plan-tier image quota migration checks passed.");
