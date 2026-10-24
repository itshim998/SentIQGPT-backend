// Exactly two reviewed migrations; no baselining, repair, resets, CLI login files,
// generic-token fallback, or application deployment. Default is read-only preflight.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { validateMigrationTracks } from "./validateMigrationTracks.mjs";

export const TARGETS = Object.freeze([
  { db: 1, ref: "lzgohufdrqjdupfsvqlj", track: "control", version: "20261024120000", name: "paid_image_edit_ledger" },
  { db: 2, ref: "dyrwqeesibzzfifljklk", track: "data", version: "20261024121000", name: "image_edit_versions" },
  { db: 3, ref: "fpklxhhsvjbjetkxqajg", track: "data", version: "20261024121000", name: "image_edit_versions" },
]);
const CONTROL_FUNCTIONS = ["reserve_image_edit_usage", "commit_image_edit_usage"];
const DATA_FUNCTIONS = ["claim_image_edit", "transition_image_edit", "prepare_image_edit_artifact", "record_image_edit_artifact", "complete_image_edit"];
const ALL_FUNCTIONS = [...CONTROL_FUNCTIONS, ...DATA_FUNCTIONS];
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const fail = (code) => { throw new Error(code); };
const namesSql = (names) => names.map(quote).join(",");
const normalize = (text) => text.replaceAll("\r\n", "\n");

// Catalog hashes contain no customer rows or credentials. Existing public RPCs,
// grants/RLS, indexes and all plan entitlements must survive the transaction.
export const BASELINE_SQL = `jsonb_build_object(
  'functions',(select coalesce(jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)),p.proacl::text) order by p.oid::regprocedure::text),'[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not in (${namesSql(ALL_FUNCTIONS)})),
  'tables',(select coalesce(jsonb_agg(jsonb_build_array(c.relname,c.relacl::text,c.relrowsecurity) order by c.relname),'[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname<>'image_edit_requests'),
  'indexes',(select coalesce(jsonb_agg(jsonb_build_array(indexname,indexdef) order by indexname),'[]'::jsonb) from pg_indexes where schemaname='public'
    and tablename<>'image_edit_requests' and indexname not in ('chat_images_edit_request_unique','chat_images_source_image_idx'))
)`;

export function resolveTargets(env) {
  const refs = new Set();
  return TARGETS.map((target) => {
    let url;
    try { url = new URL(env[`SUPABASE_URL_${target.db}`]); } catch { fail(`DB${target.db}_invalid_project_url`); }
    if (url.protocol !== "https:" || url.hostname !== `${target.ref}.supabase.co` || url.username || url.password || url.port
      || (env[`SUPABASE_PROJECT_ID_${target.db}`] && env[`SUPABASE_PROJECT_ID_${target.db}`] !== target.ref)) fail(`DB${target.db}_project_identity_mismatch`);
    if (!env[`SUPABASE_ACCESS_TOKEN_${target.db}`] || !env[`SUPABASE_SERVICE_ROLE_KEY_${target.db}`]) fail(`DB${target.db}_missing_project_specific_credentials`);
    if (refs.has(target.ref)) fail("active_project_refs_not_distinct");
    refs.add(target.ref);
    return { ...target, url: url.origin };
  });
}

export function readArtifact(root, target) {
  const { tracks } = validateMigrationTracks(root);
  const entry = tracks[target.track].find((m) => m.version === target.version);
  if (!entry || entry.scope !== (target.db === 1 ? "CONTROL_ONLY" : "DATA_ONLY")
      || entry.filename !== `${target.version}_${target.name}.sql`) fail("migration_allowlist_or_scope_mismatch");
  const raw = fs.readFileSync(path.join(root, "supabase", "migrations", entry.filename), "utf8");
  const sql = normalize(raw);
  if (/\b(drop|truncate|delete\s+from|alter\s+type)\b/i.test(sql.replace(/--[^\n]*/g, ""))) fail("unexpected_destructive_migration_statement");
  const body = sql.replace(/^([\s\S]*?)\bbegin\s*;/i, (_m, prefix) => {
    if (prefix.replace(/--[^\n]*/g, "").trim()) fail("unexpected_migration_preamble");
    return "";
  }).replace(/\bcommit\s*;\s*$/i, "");
  if (body === sql || /\b(?:commit|rollback)\s*;/i.test(body)) fail("unexpected_migration_transaction_boundary");
  const functions = [...body.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/gi)]
    .map((match) => ({ name: match[1], args: match[2].replace(/\s+/g, " ").trim().replace(/\s*,\s*/g, ", ").replace(/ default '[^']*'::jsonb/gi, ""), body: match[3] }));
  const expected = target.db === 1 ? CONTROL_FUNCTIONS : DATA_FUNCTIONS;
  if (JSON.stringify(functions.map((f) => f.name).sort()) !== JSON.stringify([...expected].sort())) fail("unexpected_migration_rpc_set");
  return { entry, raw, body, functions, checksum: hash(raw), expectedHistory: tracks[target.track].map((m) => m.version) };
}

async function api(target, env, suffix, body, readOnly = true) {
  let response;
  try {
    response = await fetch(`https://api.supabase.com/v1/projects/${target.ref}${suffix}`, {
      method: body ? "POST" : "GET", redirect: "error",
      headers: { Authorization: `Bearer ${env[`SUPABASE_ACCESS_TOKEN_${target.db}`]}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify({ ...body, ...(suffix === "/database/query" ? { read_only: readOnly } : {}) }) : undefined,
      signal: AbortSignal.timeout(readOnly ? 30000 : 90000),
    });
  } catch { fail(`DB${target.db}_management_api_connectivity_or_timeout`); }
  if (!response.ok) fail(`DB${target.db}_management_api_HTTP_${response.status}`);
  try { return await response.json(); } catch { fail(`DB${target.db}_management_api_invalid_response`); }
}
const query = (target, env, sql, readOnly = true) => api(target, env, "/database/query", { query: sql }, readOnly);

export function functionChecks(artifact) {
  return artifact.functions.map((f) => `if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=${quote(f.name)} and pg_get_function_identity_arguments(p.oid)=${quote(f.args)}
      and p.prorettype='jsonb'::regtype and p.prosecdef and 'search_path=public, pg_temp'=any(p.proconfig)
      and md5(replace(p.prosrc,chr(13)||chr(10),chr(10)))=${quote(md5(f.body))}
      and has_function_privilege('service_role',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not exists (select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
    then raise exception 'image_edit_rpc_contract_mismatch_${f.name}'; end if;`).join("\n");
}

function schemaChecks(target, artifact) {
  let sql = functionChecks(artifact) + `
    if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${namesSql(ALL_FUNCTIONS)}))<>${artifact.functions.length} then raise exception 'unexpected_image_edit_rpc_family_or_overload'; end if;`;
  if (target.db === 1) return sql + `
    if to_regclass('public.image_edit_requests') is not null or to_regclass('public.chat_images') is not null then raise exception 'control_scope_violation'; end if;`;
  sql += `
    if to_regclass('public.billing_plans') is not null or to_regclass('public.quota_reservations') is not null then raise exception 'data_scope_violation'; end if;
    if (select count(*) from information_schema.columns where table_schema='public' and table_name='chat_images'
       and (column_name,data_type) in (('source_image_id','uuid'),('edit_request_id','text'),('operation','text'),('operation_metadata','jsonb'),('content_sha256','text')))<>5 then raise exception 'image_lineage_columns_missing'; end if;
    if not exists(select 1 from pg_class where oid='public.image_edit_requests'::regclass and relrowsecurity) then raise exception 'image_edit_rls_missing'; end if;
    if has_table_privilege('anon','public.image_edit_requests','SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated','public.image_edit_requests','SELECT,INSERT,UPDATE,DELETE')
       or exists(select 1 from unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege where not has_table_privilege('service_role','public.image_edit_requests',privilege)) then raise exception 'image_edit_table_grants_invalid'; end if;
    if (select count(*) from pg_constraint where conrelid='public.image_edit_requests'::regclass and contype='f')<>4
       or (select count(*) from pg_constraint where conrelid='public.image_edit_requests'::regclass and contype='c')<>4
       or not exists(select 1 from pg_constraint where conrelid='public.chat_images'::regclass and contype='f' and pg_get_constraintdef(oid) like 'FOREIGN KEY (source_image_id)%ON DELETE SET NULL') then raise exception 'image_edit_constraints_invalid'; end if;
    if not exists(select 1 from pg_index where indexrelid='public.chat_images_edit_request_unique'::regclass and indisunique and indisvalid)
       or not exists(select 1 from pg_index where indexrelid='public.image_edit_requests_pkey'::regclass and indisunique and indisvalid)
       or not exists(select 1 from pg_index where indexrelid='public.chat_images_source_image_idx'::regclass and indisvalid) then raise exception 'image_edit_indexes_invalid'; end if;`;
  return sql;
}

async function inspect(target, env) {
  const rows = await query(target, env, `select
    (select coalesce(jsonb_agg(version::text order by version),'[]'::jsonb) from supabase_migrations.schema_migrations) as history,
    (select jsonb_agg(jsonb_build_object('name',column_name,'nullable',is_nullable,'default',column_default) order by ordinal_position) from information_schema.columns where table_schema='supabase_migrations' and table_name='schema_migrations') as history_columns,
    (select count(*) from pg_index where indrelid='supabase_migrations.schema_migrations'::regclass and indisunique and indisvalid and pg_get_indexdef(indexrelid) like '%(version)%') as history_unique,
    (select jsonb_object_agg(t,to_regclass('public.'||t) is not null) from unnest(array['billing_plans','user_subscriptions','user_db_map','quota_reservations','usage_events','users','conversations','messages','chat_images','chat_generations','image_edit_requests']) t) as objects,
    (select jsonb_agg(jsonb_build_object('name',p.proname,'signature',pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${namesSql(ALL_FUNCTIONS)})) as edit_functions,
    (select count(*) from information_schema.columns where table_schema='public' and table_name='chat_images' and column_name in ('source_image_id','edit_request_id','operation','operation_metadata','content_sha256')) as lineage_columns,
    (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and xact_start<now()-interval '1 minute') as long_transactions,
    ${BASELINE_SQL} as baseline`);
  const state = rows[0];
  if (!state || !Array.isArray(state.history) || Number(state.history_unique) < 1 || new Set(state.history).size !== state.history.length) fail(`DB${target.db}_invalid_native_history`);
  if (target.db === 1) {
    const plans = await query(target, env, "select code, price_paise, entitlements from public.billing_plans order by code");
    state.plans = plans;
    const desired = { free: [2,86400], student_core: [12,43200], premium: [20,43200], pro: [32,43200] };
    for (const [code,[limit,window]] of Object.entries(desired)) {
      const quota=plans.find((plan)=>plan.code===code)?.entitlements?.quotas?.image_generation;
      if (quota?.limit!==limit || quota?.window_seconds!==window) fail(`DB1_existing_image_quota_mismatch_${code}`);
    }
    state.retirement=(await query(target,env,`select
      (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.user_db_map'::regclass and conname='user_db_map_assigned_db_check') as constraint_definition,
      (select count(*) from public.user_db_map where assigned_db=4) as retired_mapping_count`))[0];
  }
  return state;
}

function assertRole(target, state) {
  const o=state.objects;
  const required=target.db===1 ? ['billing_plans','user_subscriptions','user_db_map','quota_reservations','usage_events'] : ['users','conversations','messages','chat_images','chat_generations'];
  const forbidden=target.db===1 ? ['chat_images','chat_generations'] : ['billing_plans','quota_reservations','usage_events','user_db_map'];
  if (required.some((key)=>!o[key]) || forbidden.some((key)=>o[key])) fail(`DB${target.db}_schema_role_mismatch`);
}

export function buildAtomicMigration(target, artifact, before, dryRun = false) {
  const columns=before.history_columns.map((c)=>c.name);
  if (!columns.includes('version') || before.history_columns.some((c)=>!['version','inserted_at','name','statements'].includes(c.name) && c.nullable==='NO' && !c.default)) fail('unsupported_history_table_contract');
  const insertColumns=['version'], values=[quote(target.version)];
  if (columns.includes('name')) {insertColumns.push('name');values.push(quote(target.name));}
  if (columns.includes('statements')) {insertColumns.push('statements');values.push(`array[${quote(`-- sentiq-canonical-sha256:${artifact.checksum}\n${artifact.body}`)}]::text[]`);}
  return `begin;
    set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='60s';
    select pg_advisory_xact_lock(hashtextextended('sentiq:reviewed-migration:${target.ref}',0));
    do $deploy_guard$ begin
      if (select coalesce(jsonb_agg(version::text order by version),'[]'::jsonb) from supabase_migrations.schema_migrations) is distinct from ${quote(JSON.stringify(before.history))}::jsonb then raise exception 'migration_history_changed_since_preflight'; end if;
      if (${BASELINE_SQL}) is distinct from ${quote(JSON.stringify(before.baseline))}::jsonb then raise exception 'schema_changed_since_preflight'; end if;
    end $deploy_guard$;
    ${artifact.body}
    insert into supabase_migrations.schema_migrations(${insertColumns.join(',')}) values(${values.join(',')});
    do $deploy_check$ begin
      ${schemaChecks(target,artifact)}
      if (${BASELINE_SQL}) is distinct from ${quote(JSON.stringify(before.baseline))}::jsonb then raise exception 'unrelated_schema_changed'; end if;
      ${target.db===1 ? `if (select jsonb_agg(jsonb_build_object('code',code,'price_paise',price_paise,'entitlements',entitlements) order by code) from public.billing_plans) is distinct from ${quote(JSON.stringify(before.plans))}::jsonb then raise exception 'billing_entitlements_changed'; end if;` : ''}
    end $deploy_check$;
    notify pgrst, 'reload schema';
    ${dryRun ? 'rollback' : 'commit'};`;
}

async function verify(target, env, artifact, before) {
  const state=await inspect(target,env); assertRole(target,state);
  if (JSON.stringify(state.history)!==JSON.stringify(artifact.expectedHistory) || JSON.stringify(state.history.filter((v)=>v!==target.version))!==JSON.stringify(before.history.filter((v)=>v!==target.version))) fail(`DB${target.db}_post_history_mismatch`);
  if (JSON.stringify(state.baseline)!==JSON.stringify(before.baseline) || JSON.stringify(state.plans)!==JSON.stringify(before.plans)) fail(`DB${target.db}_unrelated_state_changed`);
  await query(target,env,`do $verify$ begin ${schemaChecks(target,artifact)} end $verify$;`);
  // No customer data is created. These calls are guaranteed to reject before DML
  // and additionally run in read-only mode, so an accidental write also fails.
  const invalidCall=target.db===1
    ? "perform public.reserve_image_edit_usage(null,null,'image_generation',2,'image-edit:'||repeat('a',64),'{}');"
    : "perform public.claim_image_edit('image-edit:'||repeat('a',64),null,null,null,repeat('a',64),'edit','{}',null);";
  await query(target,env,`begin read only; set local role service_role;
    do $negative$ declare rejected boolean:=false; begin begin ${invalidCall} exception when others then
    if sqlerrm like '%invalid image edit identity%' or sqlerrm like '%image edit ownership denied%' then rejected:=true; else raise; end if;
    end; if not rejected then raise exception 'invalid_identity_was_accepted'; end if; end $negative$; rollback;`,false);
  for(const role of ['anon','authenticated']) await query(target,env,`begin read only; set local role ${role};
    do $denied$ declare rejected boolean:=false; begin begin ${invalidCall}
    exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'unauthorized_rpc_was_accepted'; end if; end $denied$; rollback;`,false);
  if(target.db===1) await query(target,env,`begin read only; set local role service_role;
    do $free$ declare probe uuid:=gen_random_uuid(); rejected boolean:=false; begin
    if exists(select 1 from public.user_billing_profiles where user_id=probe) then raise exception 'probe_collision'; end if;
    begin perform public.reserve_image_edit_usage(probe,null,'image_generation',2,'image-edit:'||repeat('b',64),'{"image_edit":true,"execution_mode":"fast","fingerprint":"${'b'.repeat(64)}"}');
    exception when others then if sqlerrm like '%requires paid subscription%' then rejected:=true; else raise; end if; end;
    if not rejected then raise exception 'free_edit_was_accepted'; end if; end $free$; rollback;`,false);
  let restVerified=false;
  for(let attempt=0;attempt<5;attempt++) {
    try {
      const response=await fetch(`${target.url}/rest/v1/`,{redirect:'error',headers:{apikey:env[`SUPABASE_SERVICE_ROLE_KEY_${target.db}`],Authorization:`Bearer ${env[`SUPABASE_SERVICE_ROLE_KEY_${target.db}`]}`},signal:AbortSignal.timeout(15000)});
      if(response.ok) {const spec=await response.json();restVerified=artifact.functions.every((f)=>spec.paths?.[`/rpc/${f.name}`])&&(target.db===1||Boolean(spec.paths?.['/image_edit_requests']));}
    } catch { /* Never include fetch errors or credential-bearing headers. */ }
    if(restVerified) break;
    await new Promise((resolve)=>setTimeout(resolve,500));
  }
  if(!restVerified) fail(`DB${target.db}_postgrest_schema_contract_not_available`);
  return state;
}

export async function deploy({ root=process.cwd(), env=dotenv.parse(fs.readFileSync(path.join(root,'.env'))), apply=false, dryRun=false, emit=(row)=>console.log(JSON.stringify(row)), onReport=()=>{} }={}) {
  const targets=resolveTargets(env);
  const report={ status:'preflight_in_progress', scope:'two_image_edit_migrations_only', mechanism:'Management API single PostgreSQL transaction (DDL + native migration history)', apply, dryRun, databases:[], historicalDrift:[] };
  const prepared=[];
  // Inspect every target before touching DB1; no partially investigated rollout.
  for(const target of targets) {
    const artifact=readArtifact(root,target);
    const project=await api(target,env,'');
    if(project.id!==target.ref || project.status!=='ACTIVE_HEALTHY') fail(`DB${target.db}_project_not_healthy_or_identity_mismatch`);
    const before=await inspect(target,env); assertRole(target,before);
    const pending=artifact.expectedHistory.filter((v)=>!before.history.includes(v));
    if(before.history.some((v)=>!artifact.expectedHistory.includes(v)) || pending.some((v)=>v!==target.version)) fail(`DB${target.db}_unexpected_pending_or_remote_migration`);
    const applied=before.history.includes(target.version);
    if(target.db===1 && before.history.includes('20260922120000')
       && before.retirement?.constraint_definition?.replace(/\s/g,'')!=='CHECK(((assigned_db>=2)AND(assigned_db<=3)))') {
      report.historicalDrift.push({db:1,version:'20260922120000',issue:'recorded_DB4_retirement_constraint_does_not_match_canonical_SQL',...before.retirement});
      onReport(report);
      // Existing image-edit objects can still be audited. Never mutate another
      // pending migration while a recorded prerequisite's schema is in doubt.
      if(!applied && (apply||dryRun)) fail('DB1_historical_retirement_schema_drift_requires_separate_resolution');
    }
    if(!applied && ((before.edit_functions||[]).length || before.objects.image_edit_requests || Number(before.lineage_columns))) fail(`DB${target.db}_unrecorded_partial_migration`);
    if(Number(before.long_transactions)>0) fail(`DB${target.db}_long_running_transaction_requires_recheck`);
    let serviceStatus;
    try { serviceStatus=(await fetch(`${target.url}/rest/v1/${target.db===1?'billing_plans':'chat_images'}?select=*&limit=0`,{
      method:'HEAD',redirect:'error',headers:{apikey:env[`SUPABASE_SERVICE_ROLE_KEY_${target.db}`],Authorization:`Bearer ${env[`SUPABASE_SERVICE_ROLE_KEY_${target.db}`]}`},signal:AbortSignal.timeout(15000)})).status; }
    catch { fail(`DB${target.db}_service_role_connectivity_failed`); }
    if(serviceStatus!==200 && serviceStatus!==206) fail(`DB${target.db}_service_role_HTTP_${serviceStatus}`);
    const backup=await api(target,env,'/database/backups');
    const row={db:target.db,projectRef:target.ref,role:target.track,credentialsAvailable:true,status:'preflight_verified',version:target.version,filename:artifact.entry.filename,sha256:artifact.checksum,
      historyBefore:before.history.length,pending,projectStatus:project.status,region:project.region,backup:{pitr:!!backup.pitr_enabled,availableCompleted:(backup.backups||[]).filter((b)=>b.status==='COMPLETED').length}};
    report.databases.push(row);prepared.push({target,artifact,before,row,applied});emit(row);onReport(report);
  }
  if(report.historicalDrift.length && prepared.some((entry)=>!entry.applied) && (apply||dryRun)) {
    fail('DB1_historical_retirement_schema_drift_requires_separate_resolution');
  }
  for(const {target,artifact,before,row,applied} of prepared) {
    if(applied) {const state=await verify(target,env,artifact,before);row.status='already_applied_and_verified';row.historyAfter=state.history.length;row.verifiedFunctions=artifact.functions.map((f)=>f.name);emit(row);onReport(report);continue;}
    if(!apply && !dryRun) continue;
    // Dry-run always precedes apply and rolls back schema plus history together.
    await query(target,env,buildAtomicMigration(target,artifact,before,true),false);
    const rolledBack=await inspect(target,env);
    if(JSON.stringify(rolledBack.history)!==JSON.stringify(before.history) || (rolledBack.edit_functions||[]).length || rolledBack.objects.image_edit_requests || Number(rolledBack.lineage_columns)) fail(`DB${target.db}_dry_run_did_not_roll_back`);
    row.status='dry_run_verified';emit(row);onReport(report);
    if(apply) {
      try {await query(target,env,buildAtomicMigration(target,artifact,before,false),false);}
      catch(error) {
        // Never blindly retry a write whose response may have been lost.
        const uncertain=await inspect(target,env);
        if(!uncertain.history.includes(target.version)) throw error;
      }
      row.status='applied_verification_in_progress';emit(row);onReport(report);
      const state=await verify(target,env,artifact,before);
      row.status='applied_and_verified';row.historyAfter=state.history.length;row.verifiedFunctions=artifact.functions.map((f)=>f.name);emit(row);onReport(report);
    }
  }
  report.status=report.databases.every((row)=>['already_applied_and_verified','applied_and_verified'].includes(row.status))?'fully_migrated_and_verified':dryRun?'dry_run_verified':'preflight_verified';
  onReport(report);return report;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let latestReport={databases:[]};
  const save=(report)=>{latestReport=report;fs.writeFileSync(path.resolve('docs/IMAGE_EDIT_MIGRATION_DEPLOYMENT.json'),JSON.stringify(report,null,2)+'\n');};
  deploy({apply:process.argv.includes('--apply'),dryRun:process.argv.includes('--dry-run'),onReport:save})
    .catch((error)=>{const message=/^(DB\d_|migration_|unexpected_|unsupported_|active_)/.test(error.message)?error.message:'deployment_validation_failed';
      save({...latestReport,status:'failed_or_incomplete',error:message});console.error(JSON.stringify({status:'failed_or_incomplete',error:message}));process.exitCode=1;});
}
