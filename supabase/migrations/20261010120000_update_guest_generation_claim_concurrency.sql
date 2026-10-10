-- Migration: 20261010120000_update_guest_generation_claim_concurrency.sql
-- Scope: DATA_ONLY (applied to data shards DB2 and DB3)
-- Purpose: Safely update guest generation execution claim logic with advisory transaction lock,
-- exclude self generation ID when checking active concurrency, and count only active unexpired leases.

create or replace function public.claim_guest_chat_generation_execution(
  p_owner_key_hash text,
  p_generation_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 60,
  p_max_active_generations integer default 3
)
returns public.guest_chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.guest_chat_generations%rowtype;
  v_active integer;
begin
  -- Prevent concurrent races between simultaneous claims for the same guest owner
  perform pg_advisory_xact_lock(hashtextextended(p_owner_key_hash, 0));

  select count(*) into v_active
  from public.guest_chat_generations
  where user_id = p_owner_key_hash
    and id <> p_generation_id
    and status in ('running','waiting_for_tool','generating','persisting','cancel_requested')
    and execution_lease_expires_at is not null
    and execution_lease_expires_at > now();

  if v_active >= greatest(1, p_max_active_generations) then
    raise exception using errcode = '55P03', message = 'Guest generation concurrency limit reached';
  end if;

  update public.guest_chat_generations
  set execution_lease_id = p_lease_id,
      execution_lease_expires_at = now() + make_interval(secs => greatest(15, p_lease_seconds)),
      status = case when status = 'queued' then 'running' else status end,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = p_generation_id
    and user_id = p_owner_key_hash
    and status not in ('completed','failed','cancelled')
    and (execution_lease_id is null or execution_lease_expires_at <= now() or execution_lease_id = p_lease_id)
  returning * into v_row;

  if not found then
    raise exception using errcode = '55P03', message = 'Guest generation execution lease unavailable';
  end if;
  return v_row;
end;
$$;

revoke all on function public.claim_guest_chat_generation_execution(text,uuid,uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.claim_guest_chat_generation_execution(text,uuid,uuid,integer,integer) to service_role;
