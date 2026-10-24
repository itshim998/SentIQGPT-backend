-- RUN ON: Data shards 2 and 3 only. Billing ledger stays on control DB1.
begin;
alter table public.chat_images
  add column if not exists source_image_id uuid references public.chat_images(id) on delete set null,
  add column if not exists edit_request_id text,
  add column if not exists operation text,
  add column if not exists operation_metadata jsonb,
  add column if not exists content_sha256 text;
create unique index if not exists chat_images_edit_request_unique on public.chat_images(user_id, edit_request_id)
  where edit_request_id is not null;
create index if not exists chat_images_source_image_idx on public.chat_images(source_image_id) where source_image_id is not null;

create table if not exists public.image_edit_requests (
  request_id text primary key check (request_id ~ '^image-edit:[0-9a-f]{64}$'),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  source_image_id uuid references public.chat_images(id) on delete set null,
  image_id uuid not null default gen_random_uuid(),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('edit','erase_region','replace_background','remove_background')),
  operation_metadata jsonb not null,
  status text not null default 'claimed' check (status in ('claimed','invoking','storing','generated','completed','failed')),
  lease_token uuid not null,
  lease_expires_at timestamptz not null default now() + interval '10 minutes',
  artifact jsonb,
  assistant_message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.image_edit_requests enable row level security;
revoke all on table public.image_edit_requests from public, anon, authenticated;
grant all on table public.image_edit_requests to service_role;

create or replace function public.claim_image_edit(
  p_request_id text, p_user_id uuid, p_conversation_id uuid, p_source_image_id uuid,
  p_fingerprint text, p_operation text, p_metadata jsonb, p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.image_edit_requests%rowtype; acquired boolean := false;
begin
  if not exists (select 1 from public.conversations where id=p_conversation_id and user_id=p_user_id)
    or not exists (select 1 from public.chat_images where id=p_source_image_id and user_id=p_user_id and chat_id=p_conversation_id)
    then raise exception 'image edit ownership denied'; end if;
  if not exists (select 1 from public.image_edit_requests where request_id=p_request_id)
    and exists (select 1 from public.messages where conversation_id=p_conversation_id
      and client_request_id=p_metadata->>'client_request_id' and role='assistant' and message_type='image') then
    return jsonb_build_object('conflict',true);
  end if;
  insert into public.image_edit_requests(request_id,user_id,conversation_id,source_image_id,fingerprint,operation,operation_metadata,lease_token)
    values(p_request_id,p_user_id,p_conversation_id,p_source_image_id,p_fingerprint,p_operation,p_metadata,p_lease_token)
    on conflict (request_id) do nothing;
  select * into r from public.image_edit_requests where request_id=p_request_id for update;
  if r.user_id is distinct from p_user_id or r.conversation_id is distinct from p_conversation_id or r.fingerprint is distinct from p_fingerprint then
    return jsonb_build_object('conflict',true);
  end if;
  if r.lease_token = p_lease_token then acquired := true;
  elsif r.status in ('claimed','storing','generated') and r.lease_expires_at < now() then
    update public.image_edit_requests set lease_token=p_lease_token,lease_expires_at=now()+interval '10 minutes',updated_at=now()
      where request_id=p_request_id returning * into r;
    acquired := true;
  elsif r.status='invoking' and r.lease_expires_at < now() then
    -- An external call may have succeeded. Never re-invoke an ambiguous request.
    update public.image_edit_requests set status='failed',updated_at=now() where request_id=p_request_id returning * into r;
  end if;
  return to_jsonb(r) || jsonb_build_object('acquired',acquired);
end $$;

create or replace function public.transition_image_edit(p_request_id text,p_lease_token uuid,p_status text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.image_edit_requests%rowtype;
begin
  select * into r from public.image_edit_requests where request_id=p_request_id for update;
  if r.request_id is null or r.lease_token is distinct from p_lease_token then raise exception 'image edit lease lost'; end if;
  if p_status is null or not ((r.status='claimed' and p_status='invoking') or (r.status in ('claimed','invoking','storing') and p_status='failed')) then
    raise exception 'invalid image edit transition'; end if;
  update public.image_edit_requests set status=p_status,updated_at=now() where request_id=p_request_id returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.prepare_image_edit_artifact(p_request_id text,p_lease_token uuid,p_artifact jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.image_edit_requests%rowtype;
begin
  select * into r from public.image_edit_requests where request_id=p_request_id for update;
  if r.request_id is null or r.lease_token is distinct from p_lease_token or r.status not in ('invoking','storing') then raise exception 'image edit lease lost'; end if;
  if r.status='storing' then
    if r.artifact is distinct from p_artifact then raise exception 'image edit artifact conflict'; end if;
    return to_jsonb(r);
  end if;
  if p_artifact->>'storagePath' is null
     or p_artifact->>'storagePath' not like r.user_id::text || '/' || r.conversation_id::text || '/' || r.image_id::text || '.%'
     or coalesce(p_artifact->>'contentSha256','') !~ '^[0-9a-f]{64}$'
     or coalesce((p_artifact->>'fileSizeBytes')::integer,0) not between 1 and 1048576
     or p_artifact->>'imageUrl' is null or p_artifact->>'provider' is null then raise exception 'invalid image edit artifact'; end if;
  update public.image_edit_requests set artifact=p_artifact,status='storing',updated_at=now()
    where request_id=p_request_id returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.record_image_edit_artifact(p_request_id text,p_lease_token uuid,p_artifact jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.image_edit_requests%rowtype;
begin
  select * into r from public.image_edit_requests where request_id=p_request_id for update;
  if r.request_id is null or r.lease_token is distinct from p_lease_token or r.status not in ('storing','generated') then raise exception 'image edit lease lost'; end if;
  if r.artifact is distinct from p_artifact then raise exception 'image edit artifact conflict'; end if;
  if r.status='generated' then
    if r.artifact is distinct from p_artifact then raise exception 'image edit artifact conflict'; end if;
    return to_jsonb(r);
  end if;
  if p_artifact->>'storagePath' not like r.user_id::text || '/' || r.conversation_id::text || '/' || r.image_id::text || '.%'
     or coalesce(p_artifact->>'contentSha256','') !~ '^[0-9a-f]{64}$' then raise exception 'invalid image edit artifact'; end if;
  insert into public.chat_images(id,user_id,chat_id,image_url,storage_path,prompt,provider,file_size_bytes,
    source_image_id,edit_request_id,operation,operation_metadata,content_sha256)
    values(r.image_id,r.user_id,r.conversation_id,p_artifact->>'imageUrl',p_artifact->>'storagePath',
      r.operation_metadata->>'prompt',p_artifact->>'provider',(p_artifact->>'fileSizeBytes')::integer,
      r.source_image_id,r.request_id,r.operation,r.operation_metadata,p_artifact->>'contentSha256');
  update public.image_edit_requests set artifact=p_artifact,status='generated',updated_at=now()
    where request_id=p_request_id returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.complete_image_edit(p_request_id text,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.image_edit_requests%rowtype; m public.messages%rowtype; message_request_id text;
begin
  select * into r from public.image_edit_requests where request_id=p_request_id for update;
  if r.request_id is null or r.lease_token is distinct from p_lease_token or r.status not in ('generated','completed') then raise exception 'image edit lease lost'; end if;
  if r.status='completed' then return to_jsonb(r); end if;
  message_request_id := coalesce(nullif(r.operation_metadata->>'client_request_id',''),r.request_id);
  -- Automatic chat already has a user message; manual edits need one. The
  -- existing user-request unique index preserves the original automatic turn.
  insert into public.messages(conversation_id,role,content,client_request_id)
    values(r.conversation_id,'user','Edit image: ' || (r.operation_metadata->>'prompt'),message_request_id)
    on conflict do nothing;
  insert into public.messages(conversation_id,role,content,client_request_id,message_type,image_url,storage_path,prompt,provider,file_size_bytes)
    values(r.conversation_id,'assistant','',message_request_id,'image',r.artifact->>'imageUrl',r.artifact->>'storagePath',
      r.operation_metadata->>'prompt',r.artifact->>'provider',(r.artifact->>'fileSizeBytes')::integer)
    on conflict do nothing;
  select * into m from public.messages where conversation_id=r.conversation_id and client_request_id=message_request_id
    and role='assistant' and message_type='image';
  if m.id is null or m.storage_path is distinct from r.artifact->>'storagePath' then raise exception 'image edit message conflict'; end if;
  update public.image_edit_requests set status='completed',assistant_message_id=m.id,updated_at=now()
    where request_id=p_request_id returning * into r;
  return to_jsonb(r);
end $$;

revoke all on function public.claim_image_edit(text,uuid,uuid,uuid,text,text,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.transition_image_edit(text,uuid,text) from public,anon,authenticated;
revoke all on function public.record_image_edit_artifact(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.prepare_image_edit_artifact(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.complete_image_edit(text,uuid) from public,anon,authenticated;
grant execute on function public.claim_image_edit(text,uuid,uuid,uuid,text,text,jsonb,uuid) to service_role;
grant execute on function public.transition_image_edit(text,uuid,text) to service_role;
grant execute on function public.record_image_edit_artifact(text,uuid,jsonb) to service_role;
grant execute on function public.prepare_image_edit_artifact(text,uuid,jsonb) to service_role;
grant execute on function public.complete_image_edit(text,uuid) to service_role;
commit;
