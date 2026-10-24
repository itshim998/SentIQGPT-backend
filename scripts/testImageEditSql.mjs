// Executes real PL/pgSQL locally. Install @electric-sql/pglite in a temporary
// directory and set SENTIQ_TEST_PGLITE_MODULE to its dist/index.js (no live DB).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

const engine = process.env.SENTIQ_TEST_PGLITE_MODULE;
if (!engine) throw new Error("Set SENTIQ_TEST_PGLITE_MODULE to a local @electric-sql/pglite dist/index.js to run isolated PostgreSQL tests.");
const { PGlite } = await import(pathToFileURL(path.resolve(engine)).href);
const control = new PGlite();
const shard = new PGlite();
const sql = (name) => readFileSync(path.resolve("supabase/migrations", name), "utf8");
const functionSql = (text, name) => {
  const start = text.indexOf(`create or replace function public.${name}(`);
  assert(start >= 0, name);
  return text.slice(start, text.indexOf("$$;", start) + 3);
};
const scalar = async (db, query, args = []) => (await db.query(query, args)).rows[0].value;
let assertions = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
const rejects = async (promise) => { await assert.rejects(promise); assertions++; };

try {
  await control.exec(`
    create role anon; create role authenticated; create role service_role;
    create table billing_plans(id uuid default gen_random_uuid(),code text primary key,is_active boolean default true,entitlements jsonb);
    create table test_subscriptions(user_id uuid primary key,plan_code text);
    create function get_effective_plan(p_user_id uuid) returns table(plan_code text) language sql as $$
      select coalesce((select plan_code from test_subscriptions where user_id=p_user_id),'free') $$;
    create table quota_reservations(id uuid primary key default gen_random_uuid(),user_id uuid,anonymous_key_hash text,
      plan_code text,feature text,units integer,request_id text unique,status text default 'reserved',metadata jsonb,
      reservation_expires_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
    create table usage_events(id uuid primary key default gen_random_uuid(),user_id uuid,anonymous_key_hash text,plan_code text,
      feature text,units integer,provider text,model text,safe_model_label text,route text,conversation_id text,
      client_request_id text,request_id text,metadata jsonb,created_at timestamptz default now());
    create unique index on usage_events(request_id) where request_id is not null;
  `);
  for (const [plan, limit, window] of [["free", 2, 86400], ["student_core", 12, 43200], ["premium", 20, 43200], ["pro", 32, 43200]]) {
    await control.query("insert into billing_plans(code,entitlements) values($1,$2)", [plan, { quotas: { image_generation: { limit, window_seconds: window } } }]);
  }
  const legacy = sql("20260718120000_standard_lite_token_allowances.sql");
  await control.exec(functionSql(legacy, "reserve_usage"));
  await control.exec(functionSql(legacy, "release_usage_reservation"));
  await control.exec(functionSql(sql("20261007180000_weighted_image_credits_and_revised_tiers.sql"), "commit_usage_reservation"));
  const controlMigration = sql("20261024120000_paid_image_edit_ledger.sql");
  await control.exec(controlMigration); await control.exec(controlMigration);

  const free = randomUUID(), essential = randomUUID(), pro = randomUUID();
  await control.query("insert into test_subscriptions values($1,'student_core'),($2,'pro')", [essential, pro]);
  const id = () => `image-edit:${randomUUID().replaceAll("-", "").repeat(2)}`;
  const reserve = (user, request, units = 2, mode = "fast", fingerprint = "a".repeat(64)) => scalar(control,
    "select reserve_image_edit_usage($1,null,'image_generation',$2,$3,$4) as value",
    [user, units, request, { image_edit: true, fingerprint, execution_mode: mode }]);
  const commit = (request, model, credits) => scalar(control, "select commit_image_edit_usage($1,$2,$2,'image',$3) as value",
    [request, model, { image_edit: true, actual_image_credits: credits }]);
  const klein = "@cf/black-forest-labs/flux-2-klein-4b";
  await rejects(reserve(free, id())); await rejects(reserve(null, id()));
  const request = id();
  const reserved = await reserve(essential, request); check(reserved.reserved, true); check(reserved.reservation_units, 2);
  await rejects(reserve(essential, request, 2, "fast", "b".repeat(64)));
  await rejects(commit(request, "@cf/black-forest-labs/flux-1-schnell", 1));
  await rejects(commit(request, "openai/gpt-image-2", 8));
  const attempts = await Promise.all([commit(request, klein, 2), commit(request, klein, 2)]);
  check(attempts.map((a) => a.committed), [true, true]);
  check(await scalar(control, "select count(*)::int as value from usage_events where request_id=$1", [request]), 1);
  check(await scalar(control, "select sum(units)::int as value from usage_events where user_id=$1", [essential]), 2);
  const released = id(); await reserve(essential, released);
  await scalar(control, "select release_usage_reservation($1) as value", [released]);
  check((await commit(released, klein, 2)).committed, false);
  const proRequest = id(); await reserve(pro, proRequest, 8, "intuitive");
  await rejects(commit(proRequest, klein, 2));
  check((await commit(proRequest, "microsoft/mai-image-2.6", 8)).settled_units, 8);
  const expired = id(); await reserve(essential, expired);
  await control.query("update quota_reservations set reservation_expires_at=now()-interval '1 second' where request_id=$1", [expired]);
  check((await commit(expired, klein, 2)).reason, "reservation_expired");
  check((await reserve(essential, expired)).reserved, true);
  check((await commit(expired, klein, 2)).committed, true);
  // Exhaust remaining Essential credits (12 total), then verify no overspend.
  for (let i = 0; i < 4; i++) { const key = id(); await reserve(essential, key); await commit(key, klein, 2); }
  check((await reserve(essential, id())).reserved, false);
  check(await scalar(control, "select sum(units)::int as value from usage_events where user_id=$1", [essential]), 12);
  const lateUser = randomUUID(), lateRequest = id();
  await control.query("insert into test_subscriptions values($1,'student_core')", [lateUser]);
  await reserve(lateUser, lateRequest);
  await control.query("update quota_reservations set reservation_expires_at=now()-interval '1 second' where request_id=$1", [lateRequest]);
  for (let i = 0; i < 6; i++) { const key = id(); await reserve(lateUser, key); await commit(key, klein, 2); }
  check((await reserve(lateUser, lateRequest)).reserved, false);
  check((await commit(lateRequest, klein, 2)).committed, false);
  check(await scalar(control, "select sum(units)::int as value from usage_events where user_id=$1", [lateUser]), 12);
  // Existing generation remains usable for Free and settles the actual fallback cost.
  const gen = await scalar(control, "select reserve_usage($1,null,'image_generation',1,'generation-regression','{}') as value", [free]);
  check(gen.reserved, true);
  check((await scalar(control, "select commit_usage_reservation('generation-regression','cloudflare','schnell','image','{\"actual_image_credits\":1}') as value")).settled_units, 1);
  check(await scalar(control, "select to_regclass('public.image_edit_requests')::text as value"), null);
  check(await scalar(control, "select has_function_privilege('authenticated','reserve_image_edit_usage(uuid,text,text,integer,text,jsonb)','execute') as value"), false);

  await shard.exec(`
    create role anon; create role authenticated; create role service_role;
    create table users(id uuid primary key);
    create table conversations(id uuid primary key,user_id uuid references users(id));
    create table chat_images(id uuid primary key,user_id uuid references users(id),chat_id uuid references conversations(id),
      image_url text not null,storage_path text not null,prompt text,provider text,file_size_bytes integer,created_at timestamptz default now());
    create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid references conversations(id),role text,
      content text,client_request_id text,message_type text,image_url text,storage_path text,prompt text,provider text,file_size_bytes integer);
    create unique index on messages(conversation_id,client_request_id) where role='assistant' and message_type='image' and client_request_id is not null;
    create unique index on messages(conversation_id,client_request_id) where role='user' and client_request_id is not null;
  `);
  const dataMigration = sql("20261024121000_image_edit_versions.sql");
  await shard.exec(dataMigration); await shard.exec(dataMigration);
  const chat = randomUUID(), other = randomUUID(), parent = randomUUID(), lease = randomUUID(), editId = id();
  await shard.query("insert into users values($1),($2)", [essential, other]);
  await shard.query("insert into conversations values($1,$2)", [chat, essential]);
  const originalPath = `${essential}/${chat}/${parent}.png`;
  await shard.query("insert into chat_images(id,user_id,chat_id,image_url,storage_path) values($1,$2,$3,'https://cdn.example/original',$4)", [parent, essential, chat, originalPath]);
  const claim = (request = editId, token = lease, fingerprint = "a".repeat(64), owner = essential) => scalar(shard,
    "select claim_image_edit($1,$2,$3,$4,$5,'edit',$6,$7) as value",
    [request, owner, chat, parent, fingerprint, { prompt: "wall green", source_sha256: "c".repeat(64), client_request_id: request }, token]);
  await rejects(claim(id(), randomUUID(), "a".repeat(64), other));
  const claims = await Promise.all([claim(), claim(editId, randomUUID())]);
  check(claims.map((c) => c.acquired), [true, false]); check((await claim(editId, randomUUID(), "b".repeat(64))).conflict, true);
  await rejects(scalar(shard, "select transition_image_edit($1,null,'invoking') as value", [editId]));
  await rejects(scalar(shard, "select transition_image_edit($1,$2,null) as value", [editId,lease]));
  await scalar(shard, "select transition_image_edit($1,$2,'invoking') as value", [editId, lease]);
  const artifact = { imageUrl: "https://cdn.example/edited", storagePath: `${essential}/${chat}/${claims[0].image_id}.webp`,
    fileSizeBytes: 100, contentSha256: "d".repeat(64), provider: klein };
  await rejects(scalar(shard, "select prepare_image_edit_artifact($1,$2,$3) as value", [editId,lease,{...artifact,fileSizeBytes:null}]));
  await scalar(shard, "select prepare_image_edit_artifact($1,$2,$3) as value", [editId, lease, artifact]);
  for (let i = 0; i < 2; i++) await scalar(shard, "select record_image_edit_artifact($1,$2,$3) as value", [editId, lease, artifact]);
  await rejects(scalar(shard, "select record_image_edit_artifact($1,$2,$3) as value", [editId, lease, { ...artifact, provider: "other" }]));
  await Promise.all([1, 2].map(() => scalar(shard, "select complete_image_edit($1,$2) as value", [editId, lease])));
  check(await scalar(shard, "select count(*)::int as value from messages where role='assistant'"), 1);
  check(await scalar(shard, "select count(*)::int as value from messages where role='user'"), 1);
  check(await scalar(shard, "select count(*)::int as value from chat_images where edit_request_id=$1", [editId]), 1);
  check(await scalar(shard, "select source_image_id::text as value from chat_images where edit_request_id=$1", [editId]), parent);
  check(await scalar(shard, "select storage_path as value from chat_images where id=$1", [parent]), originalPath);
  check((await claim(editId, randomUUID())).status, "completed");
  const interrupted = id(), oldLease = randomUUID(); await claim(interrupted, oldLease);
  await scalar(shard, "select transition_image_edit($1,$2,'invoking') as value", [interrupted, oldLease]);
  await shard.query("update image_edit_requests set lease_expires_at=now()-interval '1 second' where request_id=$1", [interrupted]);
  const abandoned = await claim(interrupted, randomUUID()); check(abandoned.status, "failed"); check(abandoned.acquired, false);
  await rejects(scalar(shard, "select transition_image_edit($1,$2,'invoking') as value", [interrupted, oldLease]));
  check(await scalar(shard, "select to_regclass('public.quota_reservations')::text as value"), null);
  check(await scalar(shard, "select has_table_privilege('authenticated','image_edit_requests','select') as value"), false);
  check(await scalar(shard, "select has_function_privilege('authenticated','complete_image_edit(text,uuid)','execute') as value"), false);
  check(await scalar(shard, "select has_function_privilege('authenticated','prepare_image_edit_artifact(text,uuid,jsonb)','execute') as value"), false);
  const stagedRequest = id(), stagedLease = randomUUID(); const stage = await claim(stagedRequest, stagedLease);
  await scalar(shard, "select transition_image_edit($1,$2,'invoking') as value", [stagedRequest, stagedLease]);
  const stagedArtifact = { ...artifact, storagePath: `${essential}/${chat}/${stage.image_id}.webp` };
  await scalar(shard, "select prepare_image_edit_artifact($1,$2,$3) as value", [stagedRequest, stagedLease, stagedArtifact]);
  await shard.query("update image_edit_requests set lease_expires_at=now()-interval '1 second' where request_id=$1", [stagedRequest]);
  const recoveryLease = randomUUID(); const recoveredStage = await claim(stagedRequest, recoveryLease);
  check(recoveredStage.status, "storing"); check(recoveredStage.acquired, true);
  await rejects(scalar(shard, "select record_image_edit_artifact($1,$2,$3) as value", [stagedRequest, stagedLease, stagedArtifact]));
  check((await scalar(shard, "select record_image_edit_artifact($1,$2,$3) as value", [stagedRequest, recoveryLease, stagedArtifact])).status, "generated");
  console.log(`PASS: ${assertions} isolated PostgreSQL assertions (ledger, entitlements, quota ceiling, retry identity, lineage, RPC permissions, migration idempotency and DB boundaries).`);
} finally { await control.close(); await shard.close(); }
