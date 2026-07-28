import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const allowDestructive = process.env.SENTIQ_BILLING_TEST_DATABASE_ALLOW_DESTRUCTIVE === "true";
const databaseUrl = process.env.SENTIQ_BILLING_TEST_DATABASE_URL?.trim() ?? "";

if (!allowDestructive || !databaseUrl) {
  console.log(
    "Unified text-token Pass 5.1 PostgreSQL checks skipped: " +
    "set SENTIQ_BILLING_TEST_DATABASE_URL and " +
    "SENTIQ_BILLING_TEST_DATABASE_ALLOW_DESTRUCTIVE=true for an explicitly disposable database.",
  );
  process.exit(0);
}

const parsedUrl = new URL(databaseUrl);
const databaseName = parsedUrl.pathname.replace(/^\/+/, "").toLowerCase();
const safeHost = ["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname.toLowerCase());
if (!safeHost || !databaseName.includes("test")) {
  throw new Error(
    "Refusing destructive billing integration checks: use a localhost database whose name contains 'test'.",
  );
}

const psqlVersion = spawnSync("psql", ["--version"], { encoding: "utf8" });
if (psqlVersion.status !== 0) {
  throw new Error("psql is required when the disposable PostgreSQL integration-test signal is enabled.");
}

const repoRoot = resolve(__dirname, "../..");
const migrations = [
  "supabase/migrations/20260604120000_billing_plans_usage_and_subscriptions.sql",
  "supabase/migrations/20260718120000_standard_lite_token_allowances.sql",
  "supabase/migrations/20260727120000_unified_text_tokens_v2.sql",
  "supabase/migrations/20260727180000_unified_text_tokens_v2_integrity.sql",
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
    throw new Error(`PostgreSQL integration statement failed: ${result.stderr || result.stdout}`);
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

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseJson(output: string): any {
  const line = output.split(/\r?\n/).filter(Boolean).at(-1);
  assert(line, "expected a JSON result from PostgreSQL");
  return JSON.parse(line);
}

function reserve(args: {
  userId: string;
  requestId: string;
  mode: "fast" | "intuitive";
  requested: number;
  minimum: number;
  ttlSeconds?: number;
}): any {
  const metadata = JSON.stringify({ ttl_seconds: args.ttlSeconds ?? 600 }).replace(/'/g, "''");
  return parseJson(runSql(
    `select public.reserve_unified_text_tokens_v2(` +
    `${sqlText(args.userId)}::uuid,null,${sqlText(args.requestId)},${sqlText(args.mode)},` +
    `${args.requested},${args.minimum},'${metadata}'::jsonb)::text`,
  ));
}

function commit(reservation: any, actualTokens: number): any {
  return parseJson(runSql(
    `select public.commit_unified_text_tokens_v2(` +
    `${sqlText(reservation.reservation_id)}::uuid,${sqlText(reservation.request_id)},${actualTokens},` +
    `'${JSON.stringify({
      input_tokens: Math.max(1, Math.floor(actualTokens / 2)),
      output_tokens: Math.max(1, actualTokens - Math.floor(actualTokens / 2)),
      observed_input_tokens: Math.max(1, Math.floor(actualTokens / 2)),
      observed_output_tokens: Math.max(1, actualTokens - Math.floor(actualTokens / 2)),
      successful_model_calls: 1,
      usage_reported_calls: 1,
      usage_estimated_calls: 0,
    }).replace(/'/g, "''")}'::jsonb)::text`,
  ));
}

function release(reservation: any): any {
  return parseJson(runSql(
    `select public.release_unified_text_tokens_v2(` +
    `${sqlText(reservation.reservation_id)}::uuid,${sqlText(reservation.request_id)})::text`,
  ));
}

function summary(userId: string): any {
  return parseJson(runSql(
    `select public.get_unified_text_usage_summary_v2(${sqlText(userId)}::uuid,null)::text`,
  ));
}

function reserveV1(args: {
  userId: string;
  feature: "premium_text" | "lite_text";
  requestId: string;
  units: number;
}): any {
  return parseJson(runSql(
    `select public.reserve_usage(` +
    `${sqlText(args.userId)}::uuid,null,${sqlText(args.feature)},${args.units},` +
    `${sqlText(args.requestId)},` +
    `'${JSON.stringify({
      quota_policy_version: "standard-lite-tokens-v1",
      minimum_tokens: 256,
    }).replace(/'/g, "''")}'::jsonb)::text`,
  ));
}

function countRows(sql: string): number {
  return Number(runSql(sql));
}

function main(): void {
  runSql(`
    drop schema if exists public cascade;
    create schema public;
    grant all on schema public to public;
    do $roles$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end
    $roles$;
  `);
  for (const migration of migrations) applyMigration(migration);
  applyMigration(migrations.at(-1)!);
  assert.equal(runSql("select public.get_unified_text_tokens_v2_schema_version()"), "20260727180000");

  const fullUser = "00000000-0000-0000-0000-000000005101";
  const fullReservation = reserve({
    userId: fullUser,
    requestId: "pass51-full-v2",
    mode: "fast",
    requested: 50_000,
    minimum: 256,
  });
  assert.equal(fullReservation.reservation_tokens, 50_000);
  const fullCommit = commit(fullReservation, 50_000);
  assert.equal(fullCommit.committed, true);
  assert.equal(fullCommit.rollback_shadows_synced, true);
  assert.equal(summary(fullUser).used_tokens, 50_000);
  assert.equal(summary(fullUser).legacy_v1_used_tokens, 0);

  const fullStandard = reserveV1({
    userId: fullUser,
    feature: "premium_text",
    requestId: "pass51-full-standard",
    units: 16_000,
  });
  const fullLite = reserveV1({
    userId: fullUser,
    feature: "lite_text",
    requestId: "pass51-full-lite",
    units: 12_000,
  });
  assert.equal(fullStandard.reserved, false);
  assert.equal(fullLite.reserved, false);
  assert.equal(
    countRows(
      `select count(*) from public.usage_events where user_id = ${sqlText(fullUser)}::uuid ` +
      `and metadata ->> 'unified_text_v2_rollback_shadow_class' = 'standard_gate'`,
    ),
    1,
  );
  assert.equal(
    Number(runSql(
      `select coalesce(sum(units),0) from public.usage_events where user_id = ${sqlText(fullUser)}::uuid ` +
      `and metadata ->> 'unified_text_v2_rollback_shadow_class' = 'lite_usage'`,
    )),
    50_000,
  );

  const partialUser = "00000000-0000-0000-0000-000000005102";
  const partialReservation = reserve({
    userId: partialUser,
    requestId: "pass51-partial-v2",
    mode: "fast",
    requested: 10_000,
    minimum: 256,
  });
  commit(partialReservation, 10_000);
  assert.equal(reserveV1({
    userId: partialUser,
    feature: "premium_text",
    requestId: "pass51-partial-standard",
    units: 16_000,
  }).reserved, false);
  const partialLite = reserveV1({
    userId: partialUser,
    feature: "lite_text",
    requestId: "pass51-partial-lite",
    units: 50_000,
  });
  assert.equal(partialLite.reserved, true);
  assert.equal(partialLite.reservation_units, 40_000);
  runSql(`select public.release_usage_reservation('pass51-partial-lite')::text`);
  assert.equal(summary(partialUser).used_tokens, 10_000);
  assert.equal(summary(partialUser).remaining_tokens, 40_000);

  const repeated = commit(partialReservation, 10_000);
  assert.equal(repeated.idempotent, true);
  const secondPartial = reserve({
    userId: partialUser,
    requestId: "pass51-partial-v2-second",
    mode: "fast",
    requested: 5_000,
    minimum: 256,
  });
  commit(secondPartial, 5_000);
  assert.equal(
    countRows(
      `select count(*) from public.usage_events where user_id = ${sqlText(partialUser)}::uuid ` +
      `and metadata ->> 'unified_text_v2_rollback_shadow_class' = 'standard_gate'`,
    ),
    1,
  );
  assert.equal(
    countRows(
      `select count(*) from public.usage_events where user_id = ${sqlText(partialUser)}::uuid ` +
      `and metadata ->> 'unified_text_v2_rollback_shadow_class' = 'lite_usage'`,
    ),
    2,
  );
  assert.equal(summary(partialUser).used_tokens, 15_000);
  assert.equal(summary(partialUser).legacy_v1_used_tokens, 0);

  const lateUser = "00000000-0000-0000-0000-000000005103";
  const initialUsage = reserve({
    userId: lateUser,
    requestId: "pass51-late-seed",
    mode: "fast",
    requested: 30_000,
    minimum: 256,
  });
  commit(initialUsage, 30_000);
  const lateIntuitive = reserve({
    userId: lateUser,
    requestId: "pass51-late-intuitive",
    mode: "intuitive",
    requested: 10_000,
    minimum: 1_500,
  });
  runSql(
    `update public.unified_text_reservations_v2 set reservation_expires_at = now() - interval '1 second' ` +
    `where id = ${sqlText(lateIntuitive.reservation_id)}::uuid`,
  );
  assert.equal(summary(lateUser).stale_reclaimed_tokens, 10_000);
  const competingFast = reserve({
    userId: lateUser,
    requestId: "pass51-competing-fast",
    mode: "fast",
    requested: 10_000,
    minimum: 256,
  });
  assert.equal(competingFast.reservation_tokens, 10_000);
  const lateCommit = commit(lateIntuitive, 10_000);
  assert.equal(lateCommit.committed, true);
  assert.equal(lateCommit.late_settlement, true);
  assert.equal(lateCommit.fast_reserve_breach_tokens, 10_000);
  assert.equal(lateCommit.late_capacity_overrun_tokens, 0);
  assert.equal(summary(lateUser).remaining_tokens, 0);
  assert.equal(commit(lateIntuitive, 10_000).idempotent, true);

  const debtUser = "00000000-0000-0000-0000-000000005104";
  const debtLate = reserve({
    userId: debtUser,
    requestId: "pass51-debt-late",
    mode: "fast",
    requested: 12_000,
    minimum: 256,
  });
  runSql(
    `update public.unified_text_reservations_v2 set reservation_expires_at = now() - interval '1 second' ` +
    `where id = ${sqlText(debtLate.reservation_id)}::uuid`,
  );
  summary(debtUser);
  const debtCompeting = reserve({
    userId: debtUser,
    requestId: "pass51-debt-competing",
    mode: "fast",
    requested: 45_000,
    minimum: 256,
  });
  commit(debtCompeting, 45_000);
  const debtCommit = commit(debtLate, 10_000);
  assert.equal(debtCommit.committed, true);
  assert.equal(debtCommit.late_settlement, true);
  assert.equal(debtCommit.usage_overrun_tokens, 5_000);
  assert.equal(debtCommit.late_capacity_overrun_tokens, 5_000);
  assert.equal(summary(debtUser).used_tokens, 55_000);
  assert.equal(summary(debtUser).remaining_tokens, 0);

  const releasedUser = "00000000-0000-0000-0000-000000005105";
  const releasedReservation = reserve({
    userId: releasedUser,
    requestId: "pass51-released",
    mode: "fast",
    requested: 2_000,
    minimum: 256,
  });
  assert.equal(release(releasedReservation).released, true);
  const releasedCommit = commit(releasedReservation, 1_000);
  assert.equal(releasedCommit.committed, false);
  assert.equal(releasedCommit.reason, "reservation_released");

  console.log("Unified text-token Pass 5.1 PostgreSQL integrity checks passed.");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
