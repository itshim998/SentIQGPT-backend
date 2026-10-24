-- DATA_ONLY: non-generative annotation versions on DB2/DB3. No billing changes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regclass('public.image_edit_requests') is null or to_regclass('public.billing_plans') is not null then
    raise exception 'image data shard prerequisite required'; end if;
end $$;

create table public.image_annotation_requests (
  request_id text primary key check (request_id ~ '^image-annotation:[0-9a-f]{64}$'),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  source_image_id uuid references public.chat_images(id) on delete set null,
  image_id uuid not null default gen_random_uuid(),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  operation_metadata jsonb not null check (
    coalesce(operation_metadata->>'operation','')='annotate'
    and coalesce(operation_metadata->>'source_image_id','') ~ '^[0-9a-f-]{36}$'
    and coalesce(operation_metadata->>'source_sha256','') ~ '^[0-9a-f]{64}$'
    and coalesce(operation_metadata->>'client_request_id','')<>''
    and coalesce(jsonb_typeof(operation_metadata->'annotation'),'')='object'),
  status text not null default 'claimed' check (status in ('claimed','storing','completed')),
  lease_token uuid not null,
  lease_expires_at timestamptz not null default now()+interval '10 minutes',
  artifact jsonb,
  assistant_message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.image_annotation_requests enable row level security;
revoke all on public.image_annotation_requests from public,anon,authenticated;
grant all on public.image_annotation_requests to service_role;
create index image_annotation_requests_user_idx on public.image_annotation_requests(user_id,conversation_id);
create index image_annotation_requests_conversation_idx on public.image_annotation_requests(conversation_id);
create index image_annotation_requests_source_idx on public.image_annotation_requests(source_image_id) where source_image_id is not null;

create function public.claim_image_annotation(
  p_request_id text,p_user_id uuid,p_conversation_id uuid,p_source_image_id uuid,
  p_fingerprint text,p_metadata jsonb,p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.image_annotation_requests%rowtype; acquired boolean:=false;
begin
  if p_lease_token is null or not exists(select 1 from public.conversations where id=p_conversation_id and user_id=p_user_id) then
    raise exception 'annotation ownership denied'; end if;
  if p_source_image_id is null or p_metadata->>'source_image_id' is distinct from p_source_image_id::text
    or p_metadata->>'operation' is distinct from 'annotate' then raise exception 'annotation metadata identity invalid'; end if;
  select * into r from public.image_annotation_requests where request_id=p_request_id for update;
  if r.request_id is null then
    if not exists(select 1 from public.chat_images where id=p_source_image_id and user_id=p_user_id and chat_id=p_conversation_id) then
      raise exception 'annotation source ownership denied'; end if;
    if exists(select 1 from public.messages where conversation_id=p_conversation_id
      and client_request_id=p_metadata->>'client_request_id' and role='assistant' and message_type='image') then
      return jsonb_build_object('conflict',true); end if;
    insert into public.image_annotation_requests(request_id,user_id,conversation_id,source_image_id,fingerprint,operation_metadata,lease_token)
      values(p_request_id,p_user_id,p_conversation_id,p_source_image_id,p_fingerprint,p_metadata,p_lease_token)
      on conflict(request_id) do nothing;
    select * into r from public.image_annotation_requests where request_id=p_request_id for update;
  end if;
  if r.user_id is distinct from p_user_id or r.conversation_id is distinct from p_conversation_id
    or r.fingerprint is distinct from p_fingerprint or r.operation_metadata is distinct from p_metadata
    or r.operation_metadata->>'source_image_id' is distinct from p_source_image_id::text then
    return jsonb_build_object('conflict',true); end if;
  -- Only an existing durable checkpoint can recover without the original row.
  if r.status='claimed' and not exists(select 1 from public.chat_images
      where id=p_source_image_id and user_id=p_user_id and chat_id=p_conversation_id) then
    raise exception 'annotation source ownership denied'; end if;
  if r.status='storing' and r.artifact is null then raise exception 'annotation checkpoint missing'; end if;
  if r.status<>'completed' then
    if r.lease_token=p_lease_token then acquired:=true;
    elsif r.lease_expires_at<now() then
      update public.image_annotation_requests set lease_token=p_lease_token,lease_expires_at=now()+interval '10 minutes',updated_at=now()
        where request_id=p_request_id returning * into r;
      acquired:=true;
    end if;
  end if;
  return to_jsonb(r)||jsonb_build_object('acquired',acquired);
end $$;

create function public.checkpoint_image_annotation(p_request_id text,p_lease_token uuid,p_artifact jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.image_annotation_requests%rowtype;
begin
  select * into r from public.image_annotation_requests where request_id=p_request_id for update;
  if r.request_id is null or r.lease_token is distinct from p_lease_token or r.status not in ('claimed','storing') then
    raise exception 'annotation lease lost'; end if;
  if r.status='storing' then
    if r.artifact is distinct from p_artifact then raise exception 'annotation artifact conflict'; end if;
    return to_jsonb(r);
  end if;
  if coalesce(p_artifact->>'storagePath','') !~ ('^'||r.user_id::text||'/'||r.conversation_id::text||'/'||r.image_id::text||'\.(webp|png|jpe?g)$')
    or coalesce(p_artifact->>'contentSha256','') !~ '^[0-9a-f]{64}$'
    or coalesce((p_artifact->>'fileSizeBytes')::integer,0) not between 1 and 1048576
    or coalesce(p_artifact->>'provider','')<>'sentiq/annotation'
    or coalesce(p_artifact->>'imageUrl','') !~ '^https://' then raise exception 'invalid annotation artifact'; end if;
  update public.image_annotation_requests set artifact=p_artifact,status='storing',updated_at=now()
    where request_id=p_request_id returning * into r;
  return to_jsonb(r);
end $$;

create function public.complete_image_annotation(p_request_id text,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.image_annotation_requests%rowtype; m public.messages%rowtype; client_id text;
begin
  select * into r from public.image_annotation_requests where request_id=p_request_id for update;
  if r.request_id is null or r.lease_token is distinct from p_lease_token or r.status not in ('storing','completed') then
    raise exception 'annotation lease lost'; end if;
  if r.status='completed' then return to_jsonb(r); end if;
  if r.artifact is null then raise exception 'annotation checkpoint missing'; end if;
  insert into public.chat_images(id,user_id,chat_id,image_url,storage_path,prompt,provider,file_size_bytes,
    source_image_id,edit_request_id,operation,operation_metadata,content_sha256)
  values(r.image_id,r.user_id,r.conversation_id,r.artifact->>'imageUrl',r.artifact->>'storagePath','Saved image markup',
    'sentiq/annotation',(r.artifact->>'fileSizeBytes')::integer,r.source_image_id,r.request_id,'annotate',r.operation_metadata,r.artifact->>'contentSha256');
  client_id:=r.operation_metadata->>'client_request_id';
  insert into public.messages(conversation_id,role,content,client_request_id)
    values(r.conversation_id,'user','Annotate image',client_id) on conflict do nothing;
  insert into public.messages(conversation_id,role,content,client_request_id,message_type,image_url,storage_path,prompt,provider,file_size_bytes)
    values(r.conversation_id,'assistant','',client_id,'image',r.artifact->>'imageUrl',r.artifact->>'storagePath',
      'Saved image markup','sentiq/annotation',(r.artifact->>'fileSizeBytes')::integer) on conflict do nothing;
  select * into m from public.messages where conversation_id=r.conversation_id and client_request_id=client_id and role='assistant' and message_type='image';
  if m.id is null or m.storage_path is distinct from r.artifact->>'storagePath' then raise exception 'annotation message conflict'; end if;
  update public.image_annotation_requests set status='completed',assistant_message_id=m.id,updated_at=now()
    where request_id=p_request_id returning * into r;
  return to_jsonb(r);
end $$;

create function public.get_image_annotation_schema_version() returns text language sql stable
  security definer set search_path=public,pg_temp as $$ select '20261024190000'::text $$;
revoke all on function public.claim_image_annotation(text,uuid,uuid,uuid,text,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.checkpoint_image_annotation(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.complete_image_annotation(text,uuid) from public,anon,authenticated;
revoke all on function public.get_image_annotation_schema_version() from public,anon,authenticated;
grant execute on function public.claim_image_annotation(text,uuid,uuid,uuid,text,jsonb,uuid) to service_role;
grant execute on function public.checkpoint_image_annotation(text,uuid,jsonb) to service_role;
grant execute on function public.complete_image_annotation(text,uuid) to service_role;
grant execute on function public.get_image_annotation_schema_version() to service_role;
notify pgrst,'reload schema';
commit;
