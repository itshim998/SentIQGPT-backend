// Real isolated PostgreSQL functions; never reads application credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateMigrationTracks} from './validateMigrationTracks.mjs';

assert(process.env.SENTIQ_TEST_PGLITE_MODULE,'Temporary PGlite module required; no silent integration skip');
const {PGlite}=await import(pathToFileURL(path.resolve(process.env.SENTIQ_TEST_PGLITE_MODULE)).href);
const db=new PGlite(),control=new PGlite();
const read=name=>fs.readFileSync(path.join('supabase/migrations',name),'utf8');
const migration=read('20261024190000_image_annotation_versions.sql');
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
let checks=0;const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
const rejects=async(promise)=>{await assert.rejects(promise);checks++;};
const id=()=>`image-annotation:${randomBytes(32).toString('hex')}`;
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
  create table users(id uuid primary key);
  create table conversations(id uuid primary key,user_id uuid references users(id) on delete cascade);
  create table chat_images(id uuid primary key,user_id uuid references users(id) on delete cascade,chat_id uuid references conversations(id) on delete cascade,
   image_url text not null,storage_path text not null,prompt text,provider text,file_size_bytes integer,created_at timestamptz default now());
  create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid references conversations(id) on delete cascade,role text,
   content text,client_request_id text,message_type text,image_url text,storage_path text,prompt text,provider text,file_size_bytes integer);
  create unique index on messages(conversation_id,client_request_id) where role='assistant' and message_type='image' and client_request_id is not null;
  create unique index on messages(conversation_id,client_request_id) where role='user' and client_request_id is not null;
  create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);
 `);
 await db.exec(read('20261024121000_image_edit_versions.sql'));
 // Exercise the actual DDL + native-history transaction, including failure.
 const body=migration.replace(/^--[^\n]*\n\s*begin;/i,'').replace(/commit;\s*$/i,'');
 await db.exec(`begin;${body}insert into supabase_migrations.schema_migrations values('20261024190000');rollback;`);
 check(await scalar("select to_regclass('image_annotation_requests')::text value"),null);
 check(await scalar('select count(*)::int value from supabase_migrations.schema_migrations'),0);
 await db.exec("alter table supabase_migrations.schema_migrations add constraint blocked_history check(version<>'20261024190000')");
 await rejects(db.exec(`begin;${body}insert into supabase_migrations.schema_migrations values('20261024190000');commit;`));
 await db.exec('rollback;');check(await scalar("select to_regclass('image_annotation_requests')::text value"),null);
 await db.exec('alter table supabase_migrations.schema_migrations drop constraint blocked_history');
 await db.exec(`begin;${body}insert into supabase_migrations.schema_migrations values('20261024190000');commit;`);
 check(await scalar('select get_image_annotation_schema_version() value'),'20261024190000');
 const user=randomUUID(),other=randomUUID(),chat=randomUUID(),otherChat=randomUUID(),parent=randomUUID(),foreign=randomUUID();
 await db.query('insert into users values($1),($2)',[user,other]);
 await db.query('insert into conversations values($1,$2),($3,$4)',[chat,user,otherChat,other]);
 const addSource=async(source=parent,owner=user,conversation=chat)=>db.query("insert into chat_images(id,user_id,chat_id,image_url,storage_path) values($1,$2,$3,'https://cdn.example/source',$4)",[source,owner,conversation,`${owner}/${conversation}/${source}.png`]);
 await addSource();await addSource(foreign,other,otherChat);
 const metadata=(source,client)=>({operation:'annotate',source_image_id:source,source_sha256:'c'.repeat(64),client_request_id:client,annotation:{version:1,strokes:[{color:'#00ff00',size:6,points:[{x:0.5,y:0.5}]}]}});
 const claim=(request,lease,source=parent,owner=user,conversation=chat,fingerprint='a'.repeat(64),meta=metadata(source,request))=>scalar('select claim_image_annotation($1,$2,$3,$4,$5,$6,$7) value',[request,owner,conversation,source,fingerprint,meta,lease]);
 const checkpoint=(request,lease,artifact)=>scalar('select checkpoint_image_annotation($1,$2,$3) value',[request,lease,artifact]);
 const complete=(request,lease)=>scalar('select complete_image_annotation($1,$2) value',[request,lease]);
 await rejects(claim(id(),randomUUID(),foreign));
 await rejects(claim(id(),randomUUID(),parent,other));
 const forged=id();await rejects(claim(forged,randomUUID(),parent,user,chat,'a'.repeat(64),metadata(foreign,forged)));
 check(await scalar('select count(*)::int value from image_annotation_requests where request_id=$1',[forged]),0);
 const request=id(),lease=randomUUID();const claims=await Promise.all([claim(request,lease),claim(request,randomUUID())]);
 check(claims.map(row=>row.acquired),[true,false]);
 check((await claim(request,randomUUID(),parent,user,chat,'b'.repeat(64))).conflict,true);
 check((await claim(request,randomUUID(),foreign,other,otherChat)).conflict,true);
 await rejects(complete(request,lease));
 const artifact={provider:'sentiq/annotation',imageUrl:'https://cdn.example/markup',storagePath:`${user}/${chat}/${claims[0].image_id}.webp`,fileSizeBytes:100,contentSha256:'d'.repeat(64)};
 for(const invalid of [{...artifact,provider:'openai/gpt-image-2'},{...artifact,storagePath:`${other}/${chat}/${claims[0].image_id}.webp`},
  {...artifact,storagePath:artifact.storagePath+'/../source.png'},{...artifact,fileSizeBytes:null},{...artifact,fileSizeBytes:1048577},
  {...artifact,contentSha256:'invalid'},{...artifact,imageUrl:'http://untrusted.example/image'}])await rejects(checkpoint(request,lease,invalid));
 await rejects(checkpoint(request,null,artifact));
 await checkpoint(request,lease,artifact);await checkpoint(request,lease,artifact);
 await rejects(checkpoint(request,lease,{...artifact,contentSha256:'e'.repeat(64)}));
 await Promise.all([complete(request,lease),complete(request,lease)]);
 check(await scalar('select count(*)::int value from chat_images where edit_request_id=$1',[request]),1);
 check(await scalar("select count(*)::int value from messages where client_request_id=$1 and role='assistant'",[request]),1);
 check(await scalar('select source_image_id::text value from chat_images where edit_request_id=$1',[request]),parent);
 check(await scalar('select storage_path value from chat_images where id=$1',[parent]),`${user}/${chat}/${parent}.png`);
 // Completed requests remain tombstones after explicit output deletion.
 await db.query('delete from chat_images where id=$1',[claims[0].image_id]);await complete(request,lease);
 check(await scalar('select count(*)::int value from chat_images where edit_request_id=$1',[request]),0);
 const next=id(),old=randomUUID(),nextParent=randomUUID();await addSource(nextParent);
 const nextClaim=await claim(next,old,nextParent);
 const nextArtifact={...artifact,storagePath:`${user}/${chat}/${nextClaim.image_id}.webp`};await checkpoint(next,old,nextArtifact);
 await db.query('delete from chat_images where id=$1',[nextParent]);
 check(await scalar('select source_image_id value from image_annotation_requests where request_id=$1',[next]),null);
 check((await claim(next,randomUUID(),nextParent)).acquired,false);
 await db.query("update image_annotation_requests set lease_expires_at=now()-interval '1 second' where request_id=$1",[next]);
 const newLease=randomUUID(),races=await Promise.all([claim(next,newLease,nextParent),claim(next,randomUUID(),nextParent)]);
 check(races.map(row=>row.acquired),[true,false]);
 await rejects(checkpoint(next,old,nextArtifact));
 // Lost claim/checkpoint/completion responses are safe to repeat.
 check((await claim(next,newLease,nextParent)).acquired,true);
 await checkpoint(next,newLease,nextArtifact);await complete(next,newLease);await complete(next,newLease);
 check((await claim(next,randomUUID(),nextParent)).status,'completed');
 check(await scalar("select count(*)::int value from messages where client_request_id=$1 and role='assistant'",[next]),1);
 check(await scalar('select operation_metadata->>\'source_image_id\' value from chat_images where edit_request_id=$1',[next]),nextParent);
 const fresh=id(),freshParent=randomUUID();await addSource(freshParent);await claim(fresh,randomUUID(),freshParent);
 await db.query('delete from chat_images where id=$1',[freshParent]);await rejects(claim(fresh,randomUUID(),freshParent));
 // Reusing a generative assistant-image identity never creates an annotation.
 const collision=id();await db.query("insert into messages(conversation_id,role,message_type,client_request_id,storage_path) values($1,'assistant','image',$2,'different')",[chat,collision]);
 check((await claim(collision,randomUUID())).conflict,true);
 check(await scalar('select count(*)::int value from image_annotation_requests where request_id=$1',[collision]),0);
 const afterClaim=id(),afterLease=randomUUID(),pending=await claim(afterClaim,afterLease);
 await checkpoint(afterClaim,afterLease,{...artifact,storagePath:`${user}/${chat}/${pending.image_id}.webp`});
 await db.query("insert into messages(conversation_id,role,message_type,client_request_id,storage_path) values($1,'assistant','image',$2,'other')",[chat,afterClaim]);
 await rejects(complete(afterClaim,afterLease));
 check(await scalar('select count(*)::int value from chat_images where edit_request_id=$1',[afterClaim]),0);
 check(await scalar("select status value from image_annotation_requests where request_id=$1",[afterClaim]),'storing');
 for(const role of ['anon','authenticated']){
  check(await scalar(`select has_table_privilege('${role}','image_annotation_requests','select') value`),false);
  check(await scalar(`select has_function_privilege('${role}','claim_image_annotation(text,uuid,uuid,uuid,text,jsonb,uuid)','execute') value`),false);
  await rejects(db.exec(`begin;set local role ${role};select complete_image_annotation('invalid',null);rollback;`));await db.exec('rollback;');
 }
 check(await scalar("select to_regclass('quota_reservations')::text value"),null);
 check(await scalar("select to_regclass('usage_events')::text value"),null);
 const removedConversation=id();await claim(removedConversation,randomUUID(),foreign,other,otherChat);
 await db.query('delete from conversations where id=$1',[otherChat]);
 check(await scalar('select count(*)::int value from image_annotation_requests where request_id=$1',[removedConversation]),0);
 const {tracks}=validateMigrationTracks();check(tracks.control.some(m=>m.version==='20261024190000'),false);
 check(tracks.data.some(m=>m.version==='20261024190000'),true);
 await control.exec('create table billing_plans(code text primary key)');
 await rejects(control.exec(migration));await control.exec('rollback;');
 check((await control.query("select to_regclass('image_annotation_requests') value")).rows[0].value,null);
 console.log(`PASS: ${checks} isolated annotation SQL assertions (ownership, source deletion, lease races, idempotency, messages, immutable artifacts, ACLs, scope and atomic history).`);
}finally{await db.close();await control.close();}
