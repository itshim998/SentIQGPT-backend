-- Phase 16: durable execution lease + restart recovery state.
-- The database is authoritative for ownership of a running generation.

alter table public.chat_generations
  add column if not exists execution_lease_id uuid,
  add column if not exists execution_lease_expires_at timestamptz,
  add column if not exists recovery_attempts integer not null default 0,
  add column if not exists last_execution_error text;

alter table public.chat_generations drop constraint if exists chat_generations_status_check;
alter table public.chat_generations add constraint chat_generations_status_check check (
  status in (
    'queued',
    'running',
    'completed',
    'failed',
    'recoverable',
    'cancel_requested',
    'cancelled',
    'waiting_for_tool',
    'generating',
    'persisting'
  )
);

create index if not exists chat_generations_execution_lease_idx
  on public.chat_generations (status, execution_lease_expires_at)
  where status in ('queued','running','recoverable','waiting_for_tool','generating','persisting','cancel_requested');

create or replace function public.claim_chat_generation_execution(
  p_user_id uuid,
  p_generation_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 60
)
returns public.chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generations%rowtype;
  v_now timestamptz := now();
  v_lease_seconds integer := greatest(15, p_lease_seconds);
begin
  update public.chat_generations
  set execution_lease_id = p_lease_id,
      execution_lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
      status = case
        when status = 'cancel_requested' then 'cancel_requested'
        else 'running'
      end,
      started_at = coalesce(started_at, v_now),
      recovery_attempts = recovery_attempts + case
        when status = 'recoverable'
          or (execution_lease_expires_at is not null and execution_lease_expires_at <= v_now)
        then 1 else 0 end
  where id = p_generation_id
    and user_id = p_user_id
    and status not in ('completed','failed','cancelled')
    and (
      execution_lease_id is null
      or execution_lease_expires_at is null
      or execution_lease_expires_at <= v_now
      or execution_lease_id = p_lease_id
    )
  returning * into v_row;

  if not found then
    raise exception 'Generation execution lease unavailable';
  end if;

  return v_row;
end;
$$;

create or replace function public.renew_chat_generation_execution_lease(
  p_user_id uuid,
  p_generation_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 60
)
returns public.chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generations%rowtype;
begin
  update public.chat_generations
  set execution_lease_expires_at = now() + make_interval(secs => greatest(15, p_lease_seconds))
  where id = p_generation_id
    and user_id = p_user_id
    and execution_lease_id = p_lease_id
    and status not in ('completed','failed','cancelled')
  returning * into v_row;

  if not found then
    raise exception 'Generation execution lease unavailable';
  end if;

  return v_row;
end;
$$;

create or replace function public.release_chat_generation_execution_lease(
  p_user_id uuid,
  p_generation_id uuid,
  p_lease_id uuid
)
returns public.chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generations%rowtype;
begin
  update public.chat_generations
  set execution_lease_id = null,
      execution_lease_expires_at = null
  where id = p_generation_id
    and user_id = p_user_id
    and execution_lease_id = p_lease_id
  returning * into v_row;

  if not found then
    raise exception 'Generation execution lease not owned by caller';
  end if;

  return v_row;
end;
$$;

create or replace function public.mark_chat_generation_recoverable(
  p_user_id uuid,
  p_generation_id uuid,
  p_error text default 'backend_execution_lease_expired'
)
returns public.chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generations%rowtype;
begin
  update public.chat_generations
  set status = 'recoverable',
      last_execution_error = left(coalesce(p_error, 'backend_execution_lease_expired'), 512),
      error_code = 'backend_execution_lease_expired',
      execution_lease_id = null,
      execution_lease_expires_at = null
  where id = p_generation_id
    and user_id = p_user_id
    and status in ('running','waiting_for_tool','generating','persisting','recoverable')
    and (execution_lease_expires_at is null or execution_lease_expires_at <= now());

  if not found then
    raise exception 'Generation is not recoverable';
  end if;

  select * into v_row from public.chat_generations where id = p_generation_id;
  return v_row;
end;
$$;

revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer) from public;
revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer) from anon;
revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer) from authenticated;
grant execute on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer) to service_role;

revoke all on function public.renew_chat_generation_execution_lease(uuid,uuid,uuid,integer) from public;
revoke all on function public.renew_chat_generation_execution_lease(uuid,uuid,uuid,integer) from anon;
revoke all on function public.renew_chat_generation_execution_lease(uuid,uuid,uuid,integer) from authenticated;
grant execute on function public.renew_chat_generation_execution_lease(uuid,uuid,uuid,integer) to service_role;

revoke all on function public.release_chat_generation_execution_lease(uuid,uuid,uuid) from public;
revoke all on function public.release_chat_generation_execution_lease(uuid,uuid,uuid) from anon;
revoke all on function public.release_chat_generation_execution_lease(uuid,uuid,uuid) from authenticated;
grant execute on function public.release_chat_generation_execution_lease(uuid,uuid,uuid) to service_role;

revoke all on function public.mark_chat_generation_recoverable(uuid,uuid,text) from public;
revoke all on function public.mark_chat_generation_recoverable(uuid,uuid,text) from anon;
revoke all on function public.mark_chat_generation_recoverable(uuid,uuid,text) from authenticated;
grant execute on function public.mark_chat_generation_recoverable(uuid,uuid,text) to service_role;
