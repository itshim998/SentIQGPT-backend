import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TARGETS, resolveTargets, readArtifact, buildAtomicMigration, BASELINE_SQL } from "./deployImageEditMigrations.mjs";
import { validateMigrationTracks } from "./validateMigrationTracks.mjs";
import { validateDataTrackMigrations } from "./nativeDataTrackBootstrap.mjs";

test("exact project mapping requires project-specific credentials without generic fallback", () => {
  const env={};
  for(const target of TARGETS) {env[`SUPABASE_URL_${target.db}`]=`https://${target.ref}.supabase.co`;env[`SUPABASE_ACCESS_TOKEN_${target.db}`]='fixture';env[`SUPABASE_SERVICE_ROLE_KEY_${target.db}`]='fixture';}
  assert.deepEqual(resolveTargets(env).map((target)=>target.db),[1,2,3]);
  assert.throws(()=>resolveTargets({...env,SUPABASE_ACCESS_TOKEN_1:undefined,SUPABASE_ACCESS_TOKEN:'generic'}),/missing_project_specific/);
  assert.throws(()=>resolveTargets({...env,SUPABASE_URL_3:env.SUPABASE_URL_2}),/identity_mismatch/);
  assert.throws(()=>resolveTargets({...env,SUPABASE_PROJECT_ID_1:TARGETS[1].ref}),/identity_mismatch/);
  assert(!TARGETS.some((target)=>target.db===4));
});

test("manifest validation derives counts and checks canonical files and both track copies", () => {
  const valid=validateMigrationTracks();
  assert.equal(validateDataTrackMigrations().length,valid.tracks.data.length);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sentiq-image-edit-contracts-'));
  try {
    fs.cpSync(path.resolve('supabase'),path.join(temp,'supabase'),{recursive:true,filter:(file)=>!file.includes(`${path.sep}.temp`)});
    const manifestPath=path.join(temp,'supabase','migration-manifest.json');
    const original=fs.readFileSync(manifestPath,'utf8'); const bad=JSON.parse(original);bad.counts.dataTrackTotal++;
    fs.writeFileSync(manifestPath,JSON.stringify(bad)); assert.throws(()=>validateMigrationTracks(temp),/count mismatch/);
    fs.writeFileSync(manifestPath,original);
    const copy=path.join(temp,'supabase','tracks','data','supabase','migrations',valid.tracks.data.at(-1).filename);
    fs.appendFileSync(copy,'\n-- tampered\n'); assert.throws(()=>validateMigrationTracks(temp),/checksum mismatch/);
  } finally {
    const relative=path.relative(os.tmpdir(),path.resolve(temp));
    assert(!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(temp).startsWith('sentiq-image-edit-contracts-'));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test("atomic deployment SQL allowlists artifacts and preserves native history layouts", () => {
  for(const target of TARGETS) {
    const artifact=readArtifact(process.cwd(),target);
    assert(artifact.functions.every((f)=>!/,\S/.test(f.args)),"RPC signatures must use PostgreSQL's canonical comma spacing");
    const columns=target.db===1?[{name:'version'},{name:'inserted_at'}]:[{name:'version'},{name:'name'},{name:'statements'}];
    const sql=buildAtomicMigration(target,artifact,{history:[],history_columns:columns,baseline:{},plans:[]});
    assert.equal((sql.match(/\bcommit;/gi)||[]).length,1);
    assert(sql.indexOf('insert into supabase_migrations.schema_migrations')<sql.lastIndexOf('commit;'));
    assert(sql.includes('migration_history_changed_since_preflight'));
    assert(sql.includes('set local lock_timeout'));
    assert(sql.includes(target.version));
    if(target.db!==1) assert(sql.includes(`sentiq-canonical-sha256:${artifact.checksum}`));
  }
  assert.throws(()=>readArtifact(process.cwd(),{...TARGETS[0],track:'data'}),/allowlist_or_scope/);
});

test("real PostgreSQL rolls back DDL and native history together on dry-run and history failure",{skip:!process.env.SENTIQ_TEST_PGLITE_MODULE},async()=>{
  const {PGlite}=await import(pathToFileURL(path.resolve(process.env.SENTIQ_TEST_PGLITE_MODULE)).href);
  const db=new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key, inserted_at timestamptz default now());
      create table public.quota_reservations(id uuid,user_id uuid,feature text,metadata jsonb,status text,plan_code text,units integer,reservation_expires_at timestamptz,created_at timestamptz,updated_at timestamptz,request_id text);
      create table public.usage_events(id uuid,user_id uuid,feature text,units integer,created_at timestamptz);
      create table public.billing_plans(code text,price_paise integer,entitlements jsonb);
      insert into public.billing_plans values('free',0,'{}');`);
    const baseline=(await db.query(`select ${BASELINE_SQL} as value`)).rows[0].value;
    const plans=(await db.query('select code,price_paise,entitlements from public.billing_plans order by code')).rows;
    const before={history:[],history_columns:[{name:'version'},{name:'inserted_at'}],baseline,plans};
    const target=TARGETS[0], artifact=readArtifact(process.cwd(),target);
    await db.exec(buildAtomicMigration(target,artifact,before,true));
    const count=async(name)=>(await db.query(`select count(*)::int as n from ${name}`)).rows[0].n;
    const functions=async()=>(await db.query("select count(*)::int as n from pg_proc where proname in ('reserve_image_edit_usage','commit_image_edit_usage')")).rows[0].n;
    assert.equal(await count('supabase_migrations.schema_migrations'),0);assert.equal(await functions(),0);
    await db.exec(`alter table supabase_migrations.schema_migrations add constraint history_failure check(version<>'${target.version}')`);
    await assert.rejects(db.exec(buildAtomicMigration(target,artifact,before)));
    await db.exec('rollback;');
    assert.equal(await count('supabase_migrations.schema_migrations'),0);assert.equal(await functions(),0);
    await db.exec('alter table supabase_migrations.schema_migrations drop constraint history_failure');
    await db.exec(buildAtomicMigration(target,artifact,before));
    assert.equal(await count('supabase_migrations.schema_migrations'),1);assert.equal(await functions(),2);
    await assert.rejects(db.exec(buildAtomicMigration(target,artifact,before)),/history_changed_since_preflight/);
    await db.exec('rollback;');assert.equal(await functions(),2);
  } finally {await db.close();}
});
