import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const allowDestructive = process.env.SENTIQ_BILLING_TEST_DATABASE_ALLOW_DESTRUCTIVE === "true";
const databaseUrl = process.env.SENTIQ_BILLING_TEST_DATABASE_URL?.trim() ?? "";

if (!allowDestructive || !databaseUrl) {
  console.log(
    "Unified text-token V2 PostgreSQL integration checks skipped: " +
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
const billingMigration = resolve(
  repoRoot,
  "supabase/migrations/20260604120000_billing_plans_usage_and_subscriptions.sql",
);
const v1Migration = resolve(
  repoRoot,
  "supabase/migrations/20260718120000_standard_lite_token_allowances.sql",
);
const v2Migration = resolve(
  repoRoot,
  "supabase/migrations/20260727120000_unified_text_tokens_v2.sql",
);

function psqlArgs(extra: readonly string[]): string[] {
  return ["-X", databaseUrl, "-v", "ON_ERROR_STOP=1", ...extra];
}

function runSql(sql: string): string {
  const result = spawnSync("psql", psqlArgs(["-Atq", "-c", sql]), {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`PostgreSQL integration statement failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function applyMigration(path: string): void {
  const result = spawnSync("psql", psqlArgs(["-q", "-f", path]), {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to apply disposable migration ${path}: ${result.stderr || result.stdout}`);
  }
}

function runSqlAsync(sql: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("psql", psqlArgs(["-Atq", "-c", sql]), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`Concurrent PostgreSQL statement failed: ${stderr || stdout}`));
    });
  });
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function reserveSql(args: {
  userId?: string;
  guestHash?: string;
  requestId: string;
  mode: "fast" | "intuitive";
  requested?: number;
  minimum?: number;
}): string {
  return `select public.reserve_unified_text_tokens_v2(` +
    `${args.userId ? `${sqlText(args.userId)}::uuid` : "null::uuid"},` +
    `${args.guestHash ? sqlText(args.guestHash) : "null::text"},` +
    `${sqlText(args.requestId)},${sqlText(args.mode)},` +
    `${args.requested ?? (args.mode === "fast" ? 12000 : 16000)},` +
    `${args.minimum ?? (args.mode === "fast" ? 256 : 1500)},'{}'::jsonb)::text`;
}

function parseJson(output: string): any {
  const line = output.split(/\r?\n/).filter(Boolean).at(-1);
  assert(line, "expected a JSON result from PostgreSQL");
  return JSON.parse(line);
}

function reserve(args: Parameters<typeof reserveSql>[0]): any {
  return parseJson(runSql(reserveSql(args)));
}

function summary(userId?: string, guestHash?: string): any {
  return parseJson(runSql(
    `select public.get_unified_text_usage_summary_v2(` +
    `${userId ? `${sqlText(userId)}::uuid` : "null::uuid"},` +
    `${guestHash ? sqlText(guestHash) : "null::text"})::text`,
  ));
}

function seedCommittedUsage(args: {
  userId: string;
  units: number;
  requestId: string;
  ageSeconds?: number;
  mode?: "fast" | "intuitive";
}): void {
  const ageSeconds = args.ageSeconds ?? 0;
  const mode = args.mode ?? "fast";
  runSql(`
    with reservation as (
      insert into public.unified_text_reservations_v2 (
        user_id, request_id, plan_code, policy_version, execution_mode,
        requested_tokens, minimum_tokens, reserved_tokens, actual_tokens,
        status, reservation_expires_at, created_at, updated_at
      ) values (
        ${sqlText(args.userId)}::uuid, ${sqlText(args.requestId)}, 'free',
        'unified-text-tokens-v2', ${sqlText(mode)}, ${Math.max(1, args.units)},
        1, ${Math.max(1, args.units)}, ${Math.max(1, args.units)}, 'committed',
        now() + interval '10 minutes', now() - make_interval(secs => ${ageSeconds}),
        now() - make_interval(secs => ${ageSeconds})
      ) returning id, created_at
    )
    insert into public.unified_text_usage_events_v2 (
      reservation_id, user_id, request_id, plan_code, policy_version,
      execution_mode, units, metadata, created_at
    )
    select id, ${sqlText(args.userId)}::uuid, ${sqlText(args.requestId)}, 'free',
      'unified-text-tokens-v2', ${sqlText(mode)}, ${Math.max(1, args.units)},
      '{}'::jsonb, created_at
    from reservation;
  `);
}

function releaseReservation(result: any): any {
  return parseJson(runSql(
    `select public.release_unified_text_tokens_v2(` +
    `${sqlText(result.reservation_id)}::uuid,${sqlText(result.request_id)})::text`,
  ));
}

function commitReservation(result: any, actualTokens: number): any {
  return parseJson(runSql(
    `select public.commit_unified_text_tokens_v2(` +
    `${sqlText(result.reservation_id)}::uuid,${sqlText(result.request_id)},${actualTokens},` +
    `'{"input_tokens":400,"output_tokens":600,"observed_input_tokens":400,` +
    `"observed_output_tokens":600,"successful_model_calls":1,` +
    `"usage_reported_calls":1,"usage_estimated_calls":0}'::jsonb)::text`,
  ));
}

function assertNearFuture(timestamp: string | null, minimumSeconds: number, maximumSeconds: number): void {
  assert(timestamp, "expected a dynamic recovery timestamp");
  const deltaSeconds = (Date.parse(timestamp) - Date.now()) / 1000;
  assert(
    deltaSeconds >= minimumSeconds && deltaSeconds <= maximumSeconds,
    `expected recovery in ${minimumSeconds}-${maximumSeconds}s, received ${deltaSeconds.toFixed(1)}s`,
  );
}

async function main(): Promise<void> {
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
  applyMigration(billingMigration);
  applyMigration(v1Migration);
  applyMigration(v2Migration);
  applyMigration(v2Migration);
  assert.equal(runSql("select public.get_unified_text_tokens_v2_schema_version()"), "20260727120000");

  const freshUser = "00000000-0000-0000-0000-000000001001";
  const fresh = summary(freshUser);
  assert.equal(fresh.used_tokens, 0);
  assert.equal(fresh.active_reserved_tokens, 0);
  assert.equal(fresh.remaining_tokens, 50_000);
  assert.equal(fresh.fast_available_tokens, 50_000);
  assert.equal(fresh.intuitive_available_tokens, 40_000);
  assert.equal(fresh.next_recovery_at, null);
  assert.equal(fresh.full_reset_at, null);

  const fast = reserve({ userId: freshUser, requestId: "sql-fast", mode: "fast" });
  assert.equal(fast.reserved, true);
  assert.equal(fast.reservation_tokens, 12_000);
  assert.equal(fast.remaining_tokens, 38_000);
  assert.equal(releaseReservation(fast).released, true);

  const intuitive = reserve({
    userId: freshUser,
    requestId: "sql-intuitive",
    mode: "intuitive",
  });
  assert.equal(intuitive.reserved, true);
  assert.equal(intuitive.reservation_tokens, 16_000);
  assert.equal(releaseReservation(intuitive).released, true);

  const atReserveUser = "00000000-0000-0000-0000-000000001002";
  seedCommittedUsage({ userId: atReserveUser, units: 40_000, requestId: "seed-at-reserve" });
  const atReserveIntuitive = reserve({
    userId: atReserveUser,
    requestId: "at-reserve-intuitive",
    mode: "intuitive",
  });
  assert.equal(atReserveIntuitive.reserved, false);
  assert.equal(atReserveIntuitive.reason, "intuitive_fast_required");
  assert.equal(atReserveIntuitive.remaining_tokens, 10_000);
  const atReserveFast = reserve({
    userId: atReserveUser,
    requestId: "at-reserve-fast",
    mode: "fast",
  });
  assert.equal(atReserveFast.reserved, true);
  assert.equal(atReserveFast.reservation_tokens, 10_000);

  const aboveReserveUser = "00000000-0000-0000-0000-000000001003";
  seedCommittedUsage({ userId: aboveReserveUser, units: 39_999, requestId: "seed-above-reserve" });
  const aboveReserve = reserve({
    userId: aboveReserveUser,
    requestId: "above-reserve-intuitive",
    mode: "intuitive",
  });
  assert.equal(aboveReserve.reserved, false);
  assert.equal(aboveReserve.reason, "unified_text_insufficient_for_request");
  assert.equal(aboveReserve.remaining_tokens, 10_001);
  assert.equal(aboveReserve.intuitive_available_tokens, 1);

  const belowReserveUser = "00000000-0000-0000-0000-000000001004";
  seedCommittedUsage({ userId: belowReserveUser, units: 40_001, requestId: "seed-below-reserve" });
  const belowReserveFast = reserve({
    userId: belowReserveUser,
    requestId: "below-reserve-fast",
    mode: "fast",
  });
  assert.equal(belowReserveFast.reservation_tokens, 9_999);

  const exhaustedUser = "00000000-0000-0000-0000-000000001005";
  seedCommittedUsage({ userId: exhaustedUser, units: 50_000, requestId: "seed-exhausted" });
  for (const mode of ["fast", "intuitive"] as const) {
    const result = reserve({
      userId: exhaustedUser,
      requestId: `exhausted-${mode}`,
      mode,
    });
    assert.equal(result.reserved, false);
    assert.equal(result.reason, "unified_text_quota_exhausted");
    assert.equal(result.remaining_tokens, 0);
  }

  const partialFastUser = "00000000-0000-0000-0000-000000001006";
  seedCommittedUsage({ userId: partialFastUser, units: 47_000, requestId: "seed-partial-fast" });
  assert.equal(reserve({
    userId: partialFastUser,
    requestId: "partial-fast",
    mode: "fast",
  }).reservation_tokens, 3_000);

  const partialIntuitiveUser = "00000000-0000-0000-0000-000000001007";
  seedCommittedUsage({
    userId: partialIntuitiveUser,
    units: 35_000,
    requestId: "seed-partial-intuitive",
  });
  assert.equal(reserve({
    userId: partialIntuitiveUser,
    requestId: "partial-intuitive",
    mode: "intuitive",
  }).reservation_tokens, 5_000);

  const minimumUser = "00000000-0000-0000-0000-000000001008";
  seedCommittedUsage({ userId: minimumUser, units: 38_501, requestId: "seed-minimum" });
  const minimumResult = reserve({
    userId: minimumUser,
    requestId: "minimum-intuitive",
    mode: "intuitive",
    minimum: 1_500,
  });
  assert.equal(minimumResult.reason, "unified_text_insufficient_for_request");
  assert.equal(minimumResult.intuitive_available_tokens, 1_499);

  const rollingUser = "00000000-0000-0000-0000-000000001009";
  seedCommittedUsage({
    userId: rollingUser,
    units: 2_000,
    requestId: "rolling-recovery",
    ageSeconds: 17_900,
  });
  const rolling = summary(rollingUser);
  assert.equal(rolling.used_tokens, 2_000);
  assertNearFuture(rolling.next_recovery_at, 80, 120);
  assert.equal(rolling.next_recovery_at, rolling.full_reset_at);
  runSql(`
    update public.unified_text_usage_events_v2
    set created_at = now() - interval '5 hours 1 second'
    where request_id = 'rolling-recovery';
  `);
  assert.equal(summary(rollingUser).used_tokens, 0);

  const expiringUser = "00000000-0000-0000-0000-000000001010";
  runSql(`
    insert into public.unified_text_reservations_v2 (
      user_id, request_id, plan_code, policy_version, execution_mode,
      requested_tokens, minimum_tokens, reserved_tokens, status,
      reservation_expires_at
    ) values (
      ${sqlText(expiringUser)}::uuid, 'active-expiry', 'free',
      'unified-text-tokens-v2', 'fast', 3000, 256, 3000, 'reserved',
      now() + interval '60 seconds'
    );
  `);
  const activeExpiry = summary(expiringUser);
  assert.equal(activeExpiry.active_reserved_tokens, 3_000);
  assertNearFuture(activeExpiry.next_recovery_at, 40, 80);
  runSql(`
    update public.unified_text_reservations_v2
    set reservation_expires_at = now() - interval '1 second'
    where request_id = 'active-expiry';
  `);
  const reclaimed = summary(expiringUser);
  assert.equal(reclaimed.active_reserved_tokens, 0);
  assert.equal(reclaimed.stale_reclaimed_tokens, 3_000);

  const fastRaceUser = "00000000-0000-0000-0000-000000001011";
  seedCommittedUsage({ userId: fastRaceUser, units: 45_000, requestId: "seed-fast-race" });
  const fastRace = await Promise.all([
    runSqlAsync(reserveSql({ userId: fastRaceUser, requestId: "fast-race-a", mode: "fast" })),
    runSqlAsync(reserveSql({ userId: fastRaceUser, requestId: "fast-race-b", mode: "fast" })),
  ]).then((rows) => rows.map(parseJson));
  assert.equal(
    fastRace.filter((result) => result.reserved).reduce((sum, result) => sum + result.reservation_tokens, 0),
    5_000,
  );

  const intuitiveRaceUser = "00000000-0000-0000-0000-000000001012";
  seedCommittedUsage({ userId: intuitiveRaceUser, units: 30_000, requestId: "seed-intuitive-race" });
  const intuitiveRace = await Promise.all([
    runSqlAsync(reserveSql({
      userId: intuitiveRaceUser,
      requestId: "intuitive-race-a",
      mode: "intuitive",
    })),
    runSqlAsync(reserveSql({
      userId: intuitiveRaceUser,
      requestId: "intuitive-race-b",
      mode: "intuitive",
    })),
  ]).then((rows) => rows.map(parseJson));
  assert(
    intuitiveRace.filter((result) => result.reserved)
      .reduce((sum, result) => sum + result.reservation_tokens, 0) <= 10_000,
  );
  assert(summary(intuitiveRaceUser).remaining_tokens >= 10_000);

  const mixedRaceUser = "00000000-0000-0000-0000-000000001013";
  seedCommittedUsage({ userId: mixedRaceUser, units: 30_000, requestId: "seed-mixed-race" });
  await Promise.all([
    runSqlAsync(reserveSql({ userId: mixedRaceUser, requestId: "mixed-fast", mode: "fast" })),
    runSqlAsync(reserveSql({
      userId: mixedRaceUser,
      requestId: "mixed-intuitive",
      mode: "intuitive",
    })),
  ]);
  const mixedSummary = summary(mixedRaceUser);
  assert(mixedSummary.used_tokens + mixedSummary.active_reserved_tokens <= 50_000);
  assert(mixedSummary.remaining_tokens >= 0);

  const duplicateUser = "00000000-0000-0000-0000-000000001014";
  const duplicates = await Promise.all([
    runSqlAsync(reserveSql({ userId: duplicateUser, requestId: "duplicate-request", mode: "fast" })),
    runSqlAsync(reserveSql({ userId: duplicateUser, requestId: "duplicate-request", mode: "fast" })),
  ]).then((rows) => rows.map(parseJson));
  assert.equal(new Set(duplicates.map((result) => result.reservation_id)).size, 1);
  assert.equal(duplicates.filter((result) => result.idempotent).length, 1);

  const collision = reserve({
    userId: "00000000-0000-0000-0000-000000001015",
    requestId: "duplicate-request",
    mode: "fast",
  });
  assert.equal(collision.reserved, false);
  assert.equal(collision.reason, "request_identity_mismatch");
  assert.equal(collision.reservation_id, undefined);

  const commitUser = "00000000-0000-0000-0000-000000001016";
  const commitTarget = reserve({ userId: commitUser, requestId: "commit-idempotent", mode: "fast" });
  const firstCommit = commitReservation(commitTarget, 1_000);
  const secondCommit = commitReservation(commitTarget, 1_000);
  assert.equal(firstCommit.committed, true);
  assert.equal(firstCommit.idempotent, false);
  assert.equal(secondCommit.committed, true);
  assert.equal(secondCommit.idempotent, true);
  assert.equal(
    Number(runSql("select count(*) from public.unified_text_usage_events_v2 where request_id = 'commit-idempotent'")),
    1,
  );

  const commitWindowUser = "00000000-0000-0000-0000-000000001027";
  const commitWindowTarget = reserve({
    userId: commitWindowUser,
    requestId: "commit-window-start",
    mode: "fast",
  });
  runSql(`
    update public.unified_text_reservations_v2
    set created_at = now() - interval '4 hours'
    where request_id = 'commit-window-start';
  `);
  commitReservation(commitWindowTarget, 1_000);
  assertNearFuture(summary(commitWindowUser).next_recovery_at, 17_970, 18_030);

  const releaseUser = "00000000-0000-0000-0000-000000001017";
  const releaseTarget = reserve({ userId: releaseUser, requestId: "release-idempotent", mode: "fast" });
  const firstRelease = releaseReservation(releaseTarget);
  const secondRelease = releaseReservation(releaseTarget);
  assert.equal(firstRelease.released, true);
  assert.equal(firstRelease.idempotent, false);
  assert.equal(secondRelease.released, true);
  assert.equal(secondRelease.idempotent, true);

  const terminalRaceUser = "00000000-0000-0000-0000-000000001018";
  const terminalTarget = reserve({
    userId: terminalRaceUser,
    requestId: "commit-release-race",
    mode: "fast",
  });
  await Promise.all([
    runSqlAsync(
      `select public.commit_unified_text_tokens_v2(` +
      `${sqlText(terminalTarget.reservation_id)}::uuid,'commit-release-race',900,'{}'::jsonb)::text`,
    ),
    runSqlAsync(
      `select public.release_unified_text_tokens_v2(` +
      `${sqlText(terminalTarget.reservation_id)}::uuid,'commit-release-race')::text`,
    ),
  ]);
  const terminalStatus = runSql(
    "select status from public.unified_text_reservations_v2 where request_id = 'commit-release-race'",
  );
  const terminalEvents = Number(runSql(
    "select count(*) from public.unified_text_usage_events_v2 where request_id = 'commit-release-race'",
  ));
  assert(["committed", "released"].includes(terminalStatus));
  assert.equal(terminalEvents, terminalStatus === "committed" ? 1 : 0);

  const overrunUser = "00000000-0000-0000-0000-000000001019";
  seedCommittedUsage({
    userId: overrunUser,
    units: 24_000,
    requestId: "seed-intuitive-overrun-boundary",
  });
  const overrunTarget = reserve({
    userId: overrunUser,
    requestId: "intuitive-overrun",
    mode: "intuitive",
  });
  const overrun = commitReservation(overrunTarget, 17_000);
  assert.equal(overrun.usage_overrun_tokens, 1_000);
  assert.equal(overrun.fast_reserve_breach_tokens, 1_000);
  assert.equal(summary(overrunUser).used_tokens, 41_000);

  const legacyUser = "00000000-0000-0000-0000-000000001020";
  runSql(`
    insert into public.usage_events (
      user_id, plan_code, feature, units, request_id, metadata, created_at
    ) values
      (${sqlText(legacyUser)}::uuid, 'free', 'premium_text', 5000, 'legacy-standard',
       '{"quota_policy_version":"standard-lite-tokens-v1"}'::jsonb, now() - interval '1 hour'),
      (${sqlText(legacyUser)}::uuid, 'free', 'lite_text', 7000, 'legacy-lite',
       '{"quota_policy_version":"standard-lite-tokens-v1"}'::jsonb, now() - interval '2 hours');
  `);
  const legacySummary = summary(legacyUser);
  assert.equal(legacySummary.used_tokens, 12_000);
  assert.equal(legacySummary.legacy_v1_used_tokens, 12_000);

  const activeLegacyUser = "00000000-0000-0000-0000-000000001021";
  runSql(`
    insert into public.quota_reservations (
      user_id, plan_code, feature, units, request_id, status, metadata, reservation_expires_at
    ) values (
      ${sqlText(activeLegacyUser)}::uuid, 'free', 'premium_text', 4000,
      'legacy-active-transition', 'reserved',
      '{"quota_policy_version":"standard-lite-tokens-v1","minimum_tokens":256}'::jsonb,
      now() + interval '10 minutes'
    );
  `);
  assert.equal(summary(activeLegacyUser).legacy_v1_reserved_tokens, 4_000);
  parseJson(runSql(`
    select public.commit_usage_reservation(
      'legacy-active-transition','test','test','standard',
      '{"quota_policy_version":"standard-lite-tokens-v1","actual_token_units":2000}'::jsonb
    )::text
  `));
  const transitioned = summary(activeLegacyUser);
  assert.equal(transitioned.legacy_v1_reserved_tokens, 0);
  assert.equal(transitioned.legacy_v1_used_tokens, 2_000);

  const rollbackUser = "00000000-0000-0000-0000-000000001022";
  const rollbackTarget = reserve({
    userId: rollbackUser,
    requestId: "rollback-continuity",
    mode: "fast",
  });
  commitReservation(rollbackTarget, 1_000);
  const v2AfterShadow = summary(rollbackUser);
  assert.equal(v2AfterShadow.used_tokens, 1_000);
  assert.equal(v2AfterShadow.legacy_v1_used_tokens, 0);
  assert.equal(v2AfterShadow.rollback_shadow_v1_standard_tokens, 1_000);
  const v1RollbackSummary = parseJson(runSql(
    `select public.get_usage_summary(${sqlText(rollbackUser)}::uuid,null)::text`,
  ));
  assert.equal(v1RollbackSummary.quotas.premium_text.used, 1_000);
  assert.equal(
    Number(runSql(
      "select count(*) from public.usage_events " +
      "where metadata ->> 'source_request_id' = 'rollback-continuity'",
    )),
    1,
  );

  const paidUser = "00000000-0000-0000-0000-000000001023";
  runSql(`
    insert into public.user_billing_profiles (
      user_id, current_plan_code, effective_status
    ) values (${sqlText(paidUser)}::uuid, 'premium', 'manual');
  `);
  const paidV2 = reserve({ userId: paidUser, requestId: "paid-v2-rejected", mode: "fast" });
  assert.equal(paidV2.reason, "plan_not_eligible");
  assert.equal(paidV2.plan_code, "premium");
  const paidV1 = parseJson(runSql(`
    select public.reserve_usage(
      ${sqlText(paidUser)}::uuid,null,'premium_text',12000,'paid-v1-allowed',
      '{"quota_policy_version":"standard-lite-tokens-v1","minimum_tokens":256}'::jsonb
    )::text
  `));
  assert.equal(paidV1.reserved, true);
  assert.equal(paidV1.plan_code, "premium");

  const isolationUser = "00000000-0000-0000-0000-000000001024";
  const [signedIsolation, guestIsolation] = await Promise.all([
    runSqlAsync(reserveSql({ userId: isolationUser, requestId: "isolation-user", mode: "fast" })),
    runSqlAsync(reserveSql({
      guestHash: "sql-guest-isolation-hash",
      requestId: "isolation-guest",
      mode: "fast",
    })),
  ]).then((rows) => rows.map(parseJson));
  assert.equal(signedIsolation.reservation_tokens, 12_000);
  assert.equal(guestIsolation.reservation_tokens, 12_000);
  assert.equal(summary(isolationUser).active_reserved_tokens, 12_000);
  assert.equal(summary(undefined, "sql-guest-isolation-hash").active_reserved_tokens, 12_000);

  const separateUsers = await Promise.all([
    runSqlAsync(reserveSql({
      userId: "00000000-0000-0000-0000-000000001025",
      requestId: "separate-user-a",
      mode: "intuitive",
    })),
    runSqlAsync(reserveSql({
      userId: "00000000-0000-0000-0000-000000001026",
      requestId: "separate-user-b",
      mode: "intuitive",
    })),
  ]).then((rows) => rows.map(parseJson));
  assert(separateUsers.every((result) => result.reserved && result.reservation_tokens === 16_000));

  assert.equal(
    Number(runSql(`
      select count(*) from public.unified_text_reservations_v2 r
      where r.status = 'reserved' and r.reservation_expires_at > now()
        and exists (
          select 1
          from public.unified_text_usage_events_v2 u
          where u.reservation_id = r.id
        )
    `)),
    0,
  );

  console.log("Unified text-token V2 PostgreSQL integration and concurrency checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
