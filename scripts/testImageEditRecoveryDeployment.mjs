import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {artifactFor,atomicSql,historyVerificationSql,SNAPSHOT_SQL,VERSIONS} from './deployImageEditRecoveryMigrations.mjs';
import {TARGETS} from './deployImageEditMigrations.mjs';
import {validateMigrationTracks} from './validateMigrationTracks.mjs';

test('forward recovery allowlist keeps control/data scope and transaction boundaries',()=>{
 const {tracks}=validateMigrationTracks();
 assert(!tracks.data.some(m=>m.version===VERSIONS.control[0]));
 assert(!tracks.control.some(m=>m.version===VERSIONS.data[0]));
 for(const t of TARGETS){const a=artifactFor(process.cwd(),t);assert.equal(a.version,VERSIONS[t.track][0]);
  assert.equal(a.functions.length,t.db===1?0:2);
 }
 assert.throws(()=>artifactFor(process.cwd(),{...TARGETS[0],track:'data'}),/scope_allowlist/);
});

test('DB4 repair is atomic, guarded, row preserving and rejects 1/4/NULL',async()=>{
 assert(process.env.SENTIQ_TEST_PGLITE_MODULE,'Isolated PostgreSQL engine is required; do not silently skip');
 const {PGlite}=await import(pathToFileURL(path.resolve(process.env.SENTIQ_TEST_PGLITE_MODULE)).href);
 const db=new PGlite();const t=TARGETS[0],a=artifactFor(process.cwd(),t);
 try{
  await db.exec(`create schema supabase_migrations;
   create table supabase_migrations.schema_migrations(version text primary key,inserted_at timestamptz default now());
   insert into supabase_migrations.schema_migrations(version) values('20260922120000'),('20261024120000');
   create table billing_plans(code text primary key,entitlements jsonb);
   insert into billing_plans values('free','{"quota":2}');
   create table user_db_map(id uuid primary key default gen_random_uuid(),assigned_db integer not null check(assigned_db between 2 and 4));
   create index mapping_assignment_idx on user_db_map(assigned_db);
   alter table user_db_map enable row level security;
   insert into user_db_map(assigned_db)values(2),(3);`);
  const get=async(sql)=>(await db.query(sql)).rows[0].value;
  const snapshot=await get(`select ${SNAPSHOT_SQL} as value`);
  const before={history:['20260922120000','20261024120000'],history_columns:[{name:'version'},{name:'inserted_at'}],snapshot,
   assignment:{mapping_hash:await get("select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,'[]')) value from user_db_map m"),plans:(await db.query('select * from billing_plans order by code')).rows}};
  const definition=()=>get("select pg_get_constraintdef(oid) value from pg_constraint where conrelid='user_db_map'::regclass and conname='user_db_map_assigned_db_check'");
  await db.exec(atomicSql(t,a,before,true));assert.match(await definition(),/<= 4/);
  assert.equal(await get('select count(*)::int value from supabase_migrations.schema_migrations'),2);
  await db.exec("insert into user_db_map(assigned_db)values(4)");
  const invalidSnapshot={...before,assignment:{...before.assignment,mapping_hash:await get("select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,'[]')) value from user_db_map m")}};
  await assert.rejects(db.exec(atomicSql(t,a,invalidSnapshot)),/invalid user mappings/);await db.exec('rollback;');
  assert.match(await definition(),/<= 4/);await db.exec('delete from user_db_map where assigned_db=4');
  await db.exec(`alter table supabase_migrations.schema_migrations add constraint fail_history check(version<>'${a.version}')`);
  await assert.rejects(db.exec(atomicSql(t,a,before)),/fail_history/);await db.exec('rollback;');assert.match(await definition(),/<= 4/);
  await db.exec('alter table supabase_migrations.schema_migrations drop constraint fail_history');
  await db.exec(atomicSql(t,a,before));assert.match(await definition(),/<= 3/);
  assert.deepEqual(await get(`select ${SNAPSHOT_SQL} value`),snapshot);
  for(const accepted of [2,3])await db.query('insert into user_db_map(assigned_db)values($1)',[accepted]);
  for(const rejected of [1,4,null])await assert.rejects(db.query('insert into user_db_map(assigned_db)values($1)',[rejected]));
  assert.equal(await get('select count(*)::int value from supabase_migrations.schema_migrations'),3);
  await assert.rejects(db.exec(atomicSql(t,a,before)),/migration_history_changed/);await db.exec('rollback;');
 }finally{await db.close();}
});

test('unexpected assignment schema, missing prerequisite and data-shard repair all fail closed',async()=>{
 const {PGlite}=await import(pathToFileURL(path.resolve(process.env.SENTIQ_TEST_PGLITE_MODULE)).href);
 const db=new PGlite();const sql=fs.readFileSync('supabase/migrations/20261024161000_repair_db4_assignment_constraint.sql','utf8');
 try{
  await db.exec(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text);
   create table user_db_map(assigned_db integer not null check(assigned_db between 2 and 4));create table billing_plans(code text);`);
  await assert.rejects(db.exec(sql),/prerequisites missing/);await db.exec('rollback;');
  await db.exec("insert into supabase_migrations.schema_migrations values('20260922120000'),('20261024120000');alter table user_db_map drop constraint user_db_map_assigned_db_check;alter table user_db_map add constraint user_db_map_assigned_db_check check(assigned_db between 1 and 4);");
  await assert.rejects(db.exec(sql),/unexpected assignment schema/);await db.exec('rollback;');
  await db.exec('create table chat_images(id uuid)');
  await assert.rejects(db.exec(sql),/control database required/);await db.exec('rollback;');
 }finally{await db.close();}
});

test('data recovery RPC and transition update roll back with failed native history',async()=>{
 const {PGlite}=await import(pathToFileURL(path.resolve(process.env.SENTIQ_TEST_PGLITE_MODULE)).href);
 const db=new PGlite(),t=TARGETS[1],a=artifactFor(process.cwd(),t);
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
   insert into supabase_migrations.schema_migrations(version)values('20261024121000');
   create table users(id uuid primary key);create table conversations(id uuid primary key,user_id uuid references users(id));
   create table chat_images(id uuid primary key,user_id uuid,chat_id uuid,image_url text,storage_path text,prompt text,provider text,file_size_bytes integer);
   create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,role text,content text,client_request_id text,message_type text,image_url text,storage_path text,prompt text,provider text,file_size_bytes integer);`);
  await db.exec(fs.readFileSync('supabase/migrations/20261024121000_image_edit_versions.sql','utf8'));
  const get=async(sql)=>(await db.query(sql)).rows[0].value;
  const before={history:['20261024121000'],history_columns:[{name:'version'},{name:'name'},{name:'statements'}],snapshot:await get(`select ${SNAPSHOT_SQL} value`)};
  const transition=await get("select pg_get_functiondef('transition_image_edit(text,uuid,text)'::regprocedure) value");
  const absent=async()=>assert.equal(await get("select to_regprocedure('claim_image_edit_recovery(text,uuid,uuid,uuid,text,text,jsonb,uuid)')::text value"),null);
  await db.exec(atomicSql(t,a,before,true));await absent();
  assert.equal(await get("select pg_get_functiondef('transition_image_edit(text,uuid,text)'::regprocedure) value"),transition);
  await db.exec(`alter table supabase_migrations.schema_migrations add constraint fail_history check(version<>'${a.version}')`);
  await assert.rejects(db.exec(atomicSql(t,a,before)),/fail_history/);await db.exec('rollback;');await absent();
  await db.exec('alter table supabase_migrations.schema_migrations drop constraint fail_history');
  await db.exec(atomicSql(t,a,before));
  assert.equal(await get('select count(*)::int value from supabase_migrations.schema_migrations'),2);
  assert.equal(await get("select has_function_privilege('service_role','claim_image_edit_recovery(text,uuid,uuid,uuid,text,text,jsonb,uuid)','execute') value"),true);
  assert.equal(await get("select has_function_privilege('anon','claim_image_edit_recovery(text,uuid,uuid,uuid,text,text,jsonb,uuid)','execute') value"),false);
  const history=await get(`select statements[1] value from supabase_migrations.schema_migrations where version='${a.version}'`);
  assert.equal(history,`-- sentiq-canonical-sha256:${a.checksum}\n${a.body}`);
  await db.exec(historyVerificationSql(a));
  await db.exec(`update supabase_migrations.schema_migrations set statements=array['tampered'] where version='${a.version}'`);
  await assert.rejects(db.exec(historyVerificationSql(a)),/native_history_sql_mismatch/);
 }finally{await db.close();}
});
