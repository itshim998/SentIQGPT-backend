// Narrow forward-only recovery/DB4 deployment. Defaults to read-only preflight.
// Credentials stay in process memory and HTTP headers; errors never echo bodies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {resolveTargets, readArtifact as originalArtifact, functionChecks} from './deployImageEditMigrations.mjs';
import {validateMigrationTracks} from './validateMigrationTracks.mjs';

const q=s=>`'${String(s).replaceAll("'","''")}'`;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error(code);};
export const VERSIONS={control:['20261024161000','repair_db4_assignment_constraint'],data:['20261024162000','image_edit_artifact_recovery']};
// Exclude exactly the intended changed constraint and RPC family, preserving all
// other public definitions, indexes, ACLs, policies, triggers, columns and quotas.
export const SNAPSHOT_SQL=`jsonb_build_object(
 'functions',(select coalesce(jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)),p.proacl::text) order by p.oid::regprocedure::text),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not in ('claim_image_edit_recovery','transition_image_edit')),
 'tables',(select jsonb_agg(jsonb_build_array(c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
 'constraints',(select jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid),c.convalidated) order by c.conrelid::regclass::text,c.conname) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and not(c.conrelid=coalesce(to_regclass('public.user_db_map'),0::oid) and c.conname='user_db_map_assigned_db_check')),
 'indexes',(select jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) order by tablename,indexname) from pg_indexes where schemaname='public'),
 'policies',(select jsonb_agg(to_jsonb(p) order by tablename,policyname) from pg_policies p where schemaname='public'),
 'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgrelid::regclass::text,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_array(table_name,column_name,data_type,is_nullable,column_default) order by table_name,ordinal_position) from information_schema.columns where table_schema='public')
)`;

export function artifactFor(root,target){
 const {tracks}=validateMigrationTracks(root);const [version,name]=VERSIONS[target.track];
 const entry=tracks[target.track].find(x=>x.version===version);
 if(!entry||entry.scope!==(target.db===1?'CONTROL_ONLY':'DATA_ONLY')||entry.filename!==`${version}_${name}.sql`)fail('migration_scope_allowlist_mismatch');
 const raw=fs.readFileSync(path.join(root,'supabase/migrations',entry.filename),'utf8');
 const body=raw.replace(/^--[^\n]*\n\s*begin;/i,'').replace(/commit;\s*$/i,'');
 if(body===raw||/\b(?:begin|commit|rollback)\s*;/i.test(body.replace(/\$\$[\s\S]*?\$\$/g,'')))fail('migration_transaction_boundary_invalid');
 const functions=[...body.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/gi)].map(m=>({name:m[1],args:m[2].replace(/\s+/g,' ').trim().replace(/\s*,\s*/g,', '),body:m[3]}));
 if(JSON.stringify(functions.map(f=>f.name).sort())!==JSON.stringify(target.db===1?[]:['claim_image_edit_recovery','transition_image_edit']))fail('migration_rpc_allowlist_mismatch');
 return {version,name,raw,body,functions,checksum:sha(raw),expectedHistory:tracks[target.track].map(m=>m.version)};
}

async function api(target,env,suffix,sql){
 let response;try{response=await fetch(`https://api.supabase.com/v1/projects/${target.ref}${suffix}`,{
  method:sql?'POST':'GET',redirect:'error',headers:{Authorization:`Bearer ${env[`SUPABASE_ACCESS_TOKEN_${target.db}`]}`,'Content-Type':'application/json'},
  body:sql?JSON.stringify({query:sql,read_only:!/^begin;/i.test(sql)}):undefined,signal:AbortSignal.timeout(sql?90000:30000)});}catch{fail(`DB${target.db}_management_connectivity_or_timeout`);}
 if(!response.ok)fail(`DB${target.db}_management_HTTP_${response.status}`);
 try{return await response.json();}catch{fail(`DB${target.db}_management_response_invalid`);}
}
const query=(t,e,sql)=>api(t,e,'/database/query',sql);
export async function inspect(target,env){
 const rows=await query(target,env,`select
  (select jsonb_agg(version::text order by version) from supabase_migrations.schema_migrations) history,
  (select jsonb_agg(jsonb_build_object('name',column_name,'nullable',is_nullable,'default',column_default) order by ordinal_position) from information_schema.columns where table_schema='supabase_migrations' and table_name='schema_migrations') history_columns,
  (select count(*) from pg_index where indrelid='supabase_migrations.schema_migrations'::regclass and indisunique and indisvalid and pg_get_indexdef(indexrelid) like '%(version)%') history_unique,
  (select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and xact_start<now()-interval '1 minute') long_transactions,
  (select count(*) from pg_locks where not granted and relation in (to_regclass('public.user_db_map'),to_regclass('public.image_edit_requests'),to_regclass('supabase_migrations.schema_migrations'))) waiting_locks,
  to_regclass('public.billing_plans') is not null control_role,to_regclass('public.chat_images') is not null data_role,
  ${SNAPSHOT_SQL} snapshot`);
 const s=rows[0];
 if(!s||!Array.isArray(s.history)||new Set(s.history).size!==s.history.length||Number(s.history_unique)<1)fail(`DB${target.db}_native_history_invalid`);
 if(target.db===1?(!s.control_role||s.data_role):(!s.data_role||s.control_role))fail(`DB${target.db}_schema_role_invalid`);
 if(Number(s.long_transactions)||Number(s.waiting_locks))fail(`DB${target.db}_lock_or_long_transaction_risk`);
 if(target.db===1){s.assignment=(await query(target,env,`select
   (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.user_db_map'::regclass and conname='user_db_map_assigned_db_check') definition,
   (select count(*) from public.user_db_map where assigned_db is null or assigned_db not in(2,3)) invalid,
   (select count(*) from public.user_db_map) mappings,
   (select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,'[]')) from public.user_db_map m) mapping_hash,
   (select jsonb_agg(to_jsonb(p) order by p.code) from public.billing_plans p) plans`))[0];}
 return s;
}

export function atomicSql(target,a,before,dryRun=false){
 const cols=before.history_columns;
 if(!cols.some(c=>c.name==='version')||cols.some(c=>!['version','name','statements','inserted_at'].includes(c.name)&&c.nullable==='NO'&&!c.default))fail('unsupported_native_history_layout');
 const names=['version'],values=[q(a.version)];
 if(cols.some(c=>c.name==='name')){names.push('name');values.push(q(a.name));}
 if(cols.some(c=>c.name==='statements')){names.push('statements');values.push(`array[${q(`-- sentiq-canonical-sha256:${a.checksum}\n${a.body}`)}]::text[]`);}
 return `begin;
 set local lock_timeout='5s';set local statement_timeout='60s';set local idle_in_transaction_session_timeout='60s';
 select pg_advisory_xact_lock(hashtextextended('sentiq:reviewed-migration:${target.ref}',0));
 lock table supabase_migrations.schema_migrations in share row exclusive mode;
 do $guard$ begin
  if (select jsonb_agg(version::text order by version) from supabase_migrations.schema_migrations) is distinct from ${q(JSON.stringify(before.history))}::jsonb then raise exception 'migration_history_changed';end if;
  if (${SNAPSHOT_SQL}) is distinct from ${q(JSON.stringify(before.snapshot))}::jsonb then raise exception 'schema_changed';end if;
 end $guard$;
 ${a.body}
 do $verified$ begin ${functionChecks(a)}
 ${target.db===1?`if (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.user_db_map'::regclass and conname='user_db_map_assigned_db_check') is distinct from 'CHECK (((assigned_db >= 2) AND (assigned_db <= 3)))' then raise exception 'constraint_repair_failed';end if;
 if (select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,'[]')) from public.user_db_map m) is distinct from ${q(before.assignment.mapping_hash)} then raise exception 'mapping_data_changed';end if;
 if (select jsonb_agg(to_jsonb(p) order by p.code) from public.billing_plans p) is distinct from ${q(JSON.stringify(before.assignment.plans))}::jsonb then raise exception 'billing_policy_changed';end if;`:''}
 if (${SNAPSHOT_SQL}) is distinct from ${q(JSON.stringify(before.snapshot))}::jsonb then raise exception 'unrelated_schema_changed';end if;
 end $verified$;
 insert into supabase_migrations.schema_migrations(${names.join(',')}) values(${values.join(',')});
 notify pgrst,'reload schema';
 ${dryRun?'rollback':'commit'};`;
}

export function historyVerificationSql(a){
 // The stored function bodies contain $$; a different outer delimiter is vital.
 return `do $native_history$ begin if not exists(select 1 from supabase_migrations.schema_migrations where version=${q(a.version)} and statements=array[${q(`-- sentiq-canonical-sha256:${a.checksum}\n${a.body}`)}]::text[]) then raise exception 'native_history_sql_mismatch';end if;end $native_history$;`;
}

export async function deploy({root=process.cwd(),env=dotenv.parse(fs.readFileSync(path.join(root,'.env'))),apply=false,dryRun=false,emit=row=>console.log(JSON.stringify(row))}={}){
 const targets=resolveTargets(env);const prepared=[];
 const report={scope:'forward_only_db4_and_artifact_recovery',apply,dryRun,status:'preflight',databases:[]};
 // Strict preflight of every target before the first mutation.
 for(const t of targets){
  const project=await api(t,env,'');if(project.id!==t.ref||project.status!=='ACTIVE_HEALTHY')fail(`DB${t.db}_project_identity_or_health_invalid`);
  const a=artifactFor(root,t),s=await inspect(t,env);
  const applied=s.history.includes(a.version),expected=applied?a.expectedHistory:a.expectedHistory.filter(v=>v!==a.version);
  if(JSON.stringify(s.history)!==JSON.stringify(expected))fail(`DB${t.db}_unexpected_pending_or_history_drift`);
  // Original deployed definitions must match before mutation; after deployment
  // only transition_image_edit is intentionally replaced.
  const original=originalArtifact(root,t);
  if(original.checksum!==(t.db===1?'1d593d41c9f082de622a131a54ffb940e401530c3fb58686bbd6ad5a44bee289':'0d7cd7cf1d44575f7f97559242db141d7cb00b399fd9a02c0ecbbd5c36f95afd'))fail(`DB${t.db}_original_deployed_sql_changed`);
  if(applied)original.functions=original.functions.filter(f=>f.name!=='transition_image_edit');
  await query(t,env,`do $$ begin ${functionChecks(original)} end $$;`);
  await query(t,env,`do $$ begin if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='claim_image_edit_recovery')<>${t.db===1?0:applied?1:0} then raise exception 'unexpected_recovery_rpc_or_overload';end if;end $$;`);
  if(t.db===1&&(Number(s.assignment.invalid)!==0||!['CHECK (((assigned_db >= 2) AND (assigned_db <= 4)))','CHECK (((assigned_db >= 2) AND (assigned_db <= 3)))'].includes(s.assignment.definition)))fail('DB1_unexpected_constraint_or_invalid_mappings');
  const row={db:t.db,projectRef:t.ref,version:a.version,scope:t.db===1?'CONTROL_ONLY':'DATA_ONLY',sha256:a.checksum,historyBefore:s.history.length,status:applied?'already_applied':'pending',...(t.db===1?{assignmentBefore:{definition:s.assignment.definition,invalid:Number(s.assignment.invalid),mappings:Number(s.assignment.mappings)}}:{})};
  report.databases.push(row);prepared.push({t,a,s,row,applied});emit(row);
 }
 // Rollback-only dry-run every pending transaction before any commit.
 if(apply||dryRun)for(const {t,a,s,row,applied}of prepared){if(applied)continue;
  await query(t,env,atomicSql(t,a,s,true));const after=await inspect(t,env);
  if(JSON.stringify(after)!==JSON.stringify(s))fail(`DB${t.db}_rollback_verification_failed`);
  await query(t,env,`do $$ begin ${functionChecks(originalArtifact(root,t))} end $$;`);
  row.status='dry_run_verified';emit(row);
 }
 for(const {t,a,s,row,applied}of prepared){
  if(apply&&!applied){
   try{await query(t,env,atomicSql(t,a,s));}catch(error){const uncertain=await inspect(t,env);if(!uncertain.history.includes(a.version))throw error;}
  }
  if(applied||apply){
   const after=await inspect(t,env);
   if(JSON.stringify(after.history)!==JSON.stringify(a.expectedHistory)||JSON.stringify(after.snapshot)!==JSON.stringify(s.snapshot))fail(`DB${t.db}_postapply_history_or_schema_mismatch`);
   if(t.db===1&&(after.assignment.invalid!=='0'&&Number(after.assignment.invalid)!==0||after.assignment.definition!=='CHECK (((assigned_db >= 2) AND (assigned_db <= 3)))'))fail('DB1_repaired_constraint_invalid');
   await query(t,env,`do $$ begin ${functionChecks(a)} end $$;`);
   // Verify the exact recorded new statement, where this project's native layout supports it.
   if(s.history_columns.some(c=>c.name==='statements'))await query(t,env,historyVerificationSql(a));
   if(t.db!==1){
    let visible=false;
    for(let attempt=0;attempt<5;attempt++){
     try{const response=await fetch(`${t.url}/rest/v1/`,{redirect:'error',headers:{apikey:env[`SUPABASE_SERVICE_ROLE_KEY_${t.db}`],Authorization:`Bearer ${env[`SUPABASE_SERVICE_ROLE_KEY_${t.db}`]}`},signal:AbortSignal.timeout(15000)});
      if(response.ok){const spec=await response.json();visible=Boolean(spec.paths?.['/rpc/claim_image_edit_recovery']);}
     }catch{/* Never echo credential-bearing request objects. */}
     if(visible)break;await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!visible)fail(`DB${t.db}_postgrest_recovery_rpc_missing`);
   }
   row.status=applied?'already_applied_and_verified':'applied_and_verified';row.historyAfter=after.history.length;row.rpcBodiesAndServiceOnlyAclVerified=true;row.unrelatedSchemaPreserved=true;
   if(t.db===1)row.assignmentAfter={definition:after.assignment.definition,invalid:Number(after.assignment.invalid),mappings:Number(after.assignment.mappings),mappingHashUnchanged:after.assignment.mapping_hash===s.assignment.mapping_hash,plansUnchanged:JSON.stringify(after.assignment.plans)===JSON.stringify(s.assignment.plans)};
   emit(row);
  }
 }
 report.status=report.databases.every(r=>/applied_and_verified$/.test(r.status))?'fully_applied_and_verified':dryRun?'dry_run_verified':'preflight_verified';return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const apply=process.argv.includes('--apply'),dryRun=process.argv.includes('--dry-run');
 const reportFile='docs/IMAGE_EDIT_RECOVERY_DEPLOYMENT.json';
 const prior=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile,'utf8')):null;
 const previousAttempt=prior?.previousAttempt??(prior?.status==='failed_or_incomplete'?prior:null);
 let latest={scope:'forward_only_db4_and_artifact_recovery',apply,dryRun,status:'in_progress',databases:[]};
 if(previousAttempt)latest.previousAttempt=previousAttempt;
 const save=()=>fs.writeFileSync('docs/IMAGE_EDIT_RECOVERY_DEPLOYMENT.json',JSON.stringify(latest,null,2)+'\n');
 deploy({apply,dryRun,emit:row=>{console.log(JSON.stringify(row));const index=latest.databases.findIndex(r=>r.db===row.db);if(index<0)latest.databases.push({...row});else latest.databases[index]={...row};save();}}).then(report=>{latest=report;if(previousAttempt)latest.previousAttempt=previousAttempt;save();}).catch(error=>{const code=/^(DB\d_|migration_|unsupported_)/.test(error.message)?error.message:'recovery_deployment_validation_failed';latest.status='failed_or_incomplete';latest.error=code;save();console.error(code);process.exitCode=1;});
}
