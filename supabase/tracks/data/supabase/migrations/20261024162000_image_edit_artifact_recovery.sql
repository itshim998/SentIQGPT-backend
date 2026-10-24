-- DATA_ONLY: DB2 and DB3. Fresh-edit ownership checks remain unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regclass('public.image_edit_requests') is null or to_regclass('public.billing_plans') is not null then
    raise exception 'image edit data shard required'; end if;
  if not exists(select 1 from supabase_migrations.schema_migrations where version='20261024121000') then
    raise exception 'image edit migration prerequisite missing'; end if;
end $$;
create or replace function public.claim_image_edit_recovery(
  p_request_id text, p_user_id uuid, p_conversation_id uuid, p_source_image_id uuid,
  p_fingerprint text, p_operation text, p_artifact jsonb, p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.image_edit_requests%rowtype; acquired boolean := false;
begin
  if p_lease_token is null or p_user_id is null or p_conversation_id is null then
    raise exception 'image edit recovery identity required'; end if;
  -- No INSERT, source lookup, or transition into invoking is permitted here.
  select * into r from public.image_edit_requests where request_id=p_request_id for update;
  if r.request_id is null or r.user_id is distinct from p_user_id or r.conversation_id is distinct from p_conversation_id
     or not exists(select 1 from public.conversations where id=p_conversation_id and user_id=p_user_id) then
    raise exception 'image edit recovery ownership denied'; end if;
  if r.fingerprint is distinct from p_fingerprint or r.operation is distinct from p_operation
     or r.operation_metadata->>'operation' is distinct from r.operation
     or r.operation_metadata->>'source_image_id' is distinct from p_source_image_id::text
     or p_source_image_id is null or coalesce(r.operation_metadata->>'source_sha256','') !~ '^[0-9a-f]{64}$'
     or (r.source_image_id is not null and r.source_image_id is distinct from p_source_image_id)
     or r.artifact is distinct from p_artifact then return jsonb_build_object('conflict',true); end if;
  if r.status not in ('storing','generated','completed') or r.artifact is null then
    raise exception 'image edit durable checkpoint required'; end if;
  if coalesce(r.artifact->>'storagePath','') !~ ('^'||r.user_id::text||'/'||r.conversation_id::text||'/'||r.image_id::text||'\.(webp|png|jpe?g)$')
     or coalesce(r.artifact->>'contentSha256','') !~ '^[0-9a-f]{64}$'
     or coalesce((r.artifact->>'fileSizeBytes')::integer,0) not between 1 and 1048576
     or coalesce(r.artifact->>'provider','') not in ('@cf/black-forest-labs/flux-2-klein-4b','openai/gpt-image-2','microsoft/mai-image-2.6') then
    raise exception 'image edit artifact identity invalid'; end if;
  if r.status='generated' and not exists(select 1 from public.chat_images i
      where i.id=r.image_id and i.user_id=r.user_id and i.chat_id=r.conversation_id and i.edit_request_id=r.request_id
        and i.storage_path=r.artifact->>'storagePath' and i.image_url=r.artifact->>'imageUrl'
        and i.content_sha256=r.artifact->>'contentSha256' and i.operation=r.operation
        and i.operation_metadata=r.operation_metadata) then raise exception 'image edit output record missing'; end if;
  if r.status <> 'completed' then
    if r.lease_token=p_lease_token then acquired := true;
    elsif r.lease_expires_at < now() then
      update public.image_edit_requests set lease_token=p_lease_token,lease_expires_at=now()+interval '10 minutes',updated_at=now()
        where request_id=p_request_id returning * into r;
      acquired := true;
    end if;
  end if;
  return to_jsonb(r) || jsonb_build_object('acquired',acquired);
end $$;

-- A verified missing/corrupt generated output must be terminally releasable too.
create or replace function public.transition_image_edit(p_request_id text,p_lease_token uuid,p_status text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.image_edit_requests%rowtype;
begin
  select * into r from public.image_edit_requests where request_id=p_request_id for update;
  if r.request_id is null or r.lease_token is distinct from p_lease_token then raise exception 'image edit lease lost'; end if;
  if p_status is null or not ((r.status='claimed' and p_status='invoking') or (r.status in ('claimed','invoking','storing','generated') and p_status='failed')) then
    raise exception 'invalid image edit transition'; end if;
  update public.image_edit_requests set status=p_status,updated_at=now() where request_id=p_request_id returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.claim_image_edit_recovery(text,uuid,uuid,uuid,text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.claim_image_edit_recovery(text,uuid,uuid,uuid,text,text,jsonb,uuid) to service_role;
revoke all on function public.transition_image_edit(text,uuid,text) from public,anon,authenticated;
grant execute on function public.transition_image_edit(text,uuid,text) to service_role;
commit;
