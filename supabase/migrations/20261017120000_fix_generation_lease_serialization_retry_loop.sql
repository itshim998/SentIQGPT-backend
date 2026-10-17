-- Migration: 20261017120000_fix_generation_lease_serialization_retry_loop.sql
-- Scope: DATA_ONLY (applied to data shards DB2 and DB3)
-- Purpose: Replace SQLSTATE '40001' (serialization_failure) with 'P0001' (raise_exception) in all
-- generation lease fencing and event sequencing RPCs.
--
-- Root Cause Addressed:
-- PostgREST treats SQLSTATE Class 40 ('40001' serialization_failure) as a transient concurrency anomaly
-- and automatically retries the entire transaction within the same HTTP connection.
-- When a generation execution lease is lost or a sequence mismatch occurs, the condition is permanent.
-- Emitting '40001' caused PostgREST to enter an unthrottled Haskell retry loop (>2,000 queries/sec),
-- saturating database CPU at 100% and generating hundreds of thousands of PostgreSQL errors while API
-- Gateway recorded only the single persistent HTTP connection.
-- Using 'P0001' ensures PostgREST treats lease loss as an immediate terminal client error (HTTP 400/409)
-- without retrying.

-- 1. checkpoint_chat_generation_fenced
create or replace function public.checkpoint_chat_generation_fenced(
  p_user_id uuid,
  p_generation_id uuid,
  p_lease_id uuid,
  p_partial_text text default null,
  p_tokens_generated integer default null,
  p_last_event_sequence integer default null,
  p_status text default null
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
  set partial_text = coalesce(p_partial_text, partial_text),
      tokens_generated = case when p_tokens_generated is null then tokens_generated else greatest(0, p_tokens_generated) end,
      last_event_sequence = case when p_last_event_sequence is null then last_event_sequence else greatest(0, p_last_event_sequence) end,
      status = case when p_status is null then status else p_status end
  where id = p_generation_id
    and user_id = p_user_id
    and execution_lease_id = p_lease_id
    and status not in ('completed', 'failed', 'cancelled')
  returning * into v_row;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'Generation execution lease lost';
  end if;

  return v_row;
end;
$$;

revoke all on function public.checkpoint_chat_generation_fenced(uuid,uuid,uuid,text,integer,integer,text) from public, anon, authenticated;
grant execute on function public.checkpoint_chat_generation_fenced(uuid,uuid,uuid,text,integer,integer,text) to service_role;

-- 2. finalize_chat_generation_fenced
create or replace function public.finalize_chat_generation_fenced(
  p_user_id uuid,
  p_generation_id uuid,
  p_lease_id uuid,
  p_status text,
  p_error_code text default null,
  p_partial_text text default null,
  p_tokens_generated integer default null,
  p_last_event_sequence integer default null
)
returns public.chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generations%rowtype;
  v_now timestamptz := now();
begin
  update public.chat_generations
  set status = p_status,
      error_code = case when p_error_code is null then error_code else left(p_error_code, 512) end,
      partial_text = coalesce(p_partial_text, partial_text),
      tokens_generated = case when p_tokens_generated is null then tokens_generated else greatest(0, p_tokens_generated) end,
      last_event_sequence = case when p_last_event_sequence is null then last_event_sequence else greatest(0, p_last_event_sequence) end,
      completed_at = case when p_status = 'completed' then coalesce(completed_at, v_now) else completed_at end,
      failed_at = case when p_status = 'failed' then coalesce(failed_at, v_now) else failed_at end,
      cancelled_at = case when p_status = 'cancelled' then coalesce(cancelled_at, v_now) else cancelled_at end
  where id = p_generation_id
    and user_id = p_user_id
    and execution_lease_id = p_lease_id
    and status not in ('completed', 'failed', 'cancelled')
  returning * into v_row;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'Generation execution lease lost';
  end if;

  return v_row;
end;
$$;

revoke all on function public.finalize_chat_generation_fenced(uuid,uuid,uuid,text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.finalize_chat_generation_fenced(uuid,uuid,uuid,text,text,text,integer,integer) to service_role;

-- 3. append_chat_generation_event_fenced
create or replace function public.append_chat_generation_event_fenced(
  p_user_id uuid,
  p_generation_id uuid,
  p_lease_id uuid,
  p_sequence integer,
  p_event_type text,
  p_event_payload jsonb,
  p_partial_text text default null,
  p_tokens_generated integer default null,
  p_status text default null,
  p_error_code text default null
)
returns public.chat_generation_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.chat_generation_events%rowtype;
  v_generation public.chat_generations%rowtype;
begin
  select * into v_generation
  from public.chat_generations
  where id = p_generation_id
    and user_id = p_user_id
    and execution_lease_id = p_lease_id
    and status not in ('completed','failed','cancelled');

  if not found then
    raise exception using errcode = 'P0001', message = 'Generation execution lease lost';
  end if;

  if p_sequence <> v_generation.last_event_sequence + 1 then
    raise exception using
      errcode = 'P0001',
      message = format('Generation event sequence mismatch: expected %s received %s', v_generation.last_event_sequence + 1, p_sequence);
  end if;

  insert into public.chat_generation_events (
    generation_id,
    user_id,
    sequence,
    event_type,
    event_payload
  ) values (
    p_generation_id,
    p_user_id,
    p_sequence,
    left(coalesce(p_event_type, 'generation_event'), 128),
    p_event_payload
  )
  returning * into v_event;

  update public.chat_generations
  set partial_text = coalesce(p_partial_text, partial_text),
      tokens_generated = case
        when p_tokens_generated is null then tokens_generated
        else greatest(0, p_tokens_generated)
      end,
      last_event_sequence = p_sequence,
      status = coalesce(p_status, status),
      error_code = case
        when p_error_code is null then error_code
        else left(p_error_code, 512)
      end
  where id = p_generation_id
    and user_id = p_user_id
    and execution_lease_id = p_lease_id;

  return v_event;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'Generation event sequence already exists';
end;
$$;

revoke all on function public.append_chat_generation_event_fenced(uuid,uuid,uuid,integer,text,jsonb,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.append_chat_generation_event_fenced(uuid,uuid,uuid,integer,text,jsonb,text,integer,text,text) to service_role;

-- 4. renew_guest_chat_generation_execution_lease
create or replace function public.renew_guest_chat_generation_execution_lease(
  p_owner_key_hash text,
  p_generation_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 60
)
returns public.guest_chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.guest_chat_generations%rowtype;
begin
  update public.guest_chat_generations
  set execution_lease_expires_at = now() + make_interval(secs => greatest(15, p_lease_seconds)),
      updated_at = now()
  where id = p_generation_id
    and user_id = p_owner_key_hash
    and execution_lease_id = p_lease_id
    and status not in ('completed','failed','cancelled')
  returning * into v_row;

  if not found then
    raise exception using errcode = 'P0001', message = 'Guest generation execution lease lost';
  end if;

  return v_row;
end;
$$;

revoke all on function public.renew_guest_chat_generation_execution_lease(text,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.renew_guest_chat_generation_execution_lease(text,uuid,uuid,integer) to service_role;

-- 5. append_guest_chat_generation_event_fenced
create or replace function public.append_guest_chat_generation_event_fenced(
  p_owner_key_hash text,
  p_generation_id uuid,
  p_lease_id uuid,
  p_sequence integer,
  p_event_type text,
  p_event_payload jsonb,
  p_partial_text text default null,
  p_tokens_generated integer default null,
  p_status text default null,
  p_error_code text default null
)
returns public.guest_chat_generation_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.guest_chat_generation_events%rowtype;
  v_generation public.guest_chat_generations%rowtype;
begin
  select * into v_generation
  from public.guest_chat_generations
  where id = p_generation_id
    and user_id = p_owner_key_hash
    and execution_lease_id = p_lease_id
    and status not in ('completed','failed','cancelled');

  if not found then
    raise exception using errcode = 'P0001', message = 'Guest generation execution lease lost';
  end if;

  if p_sequence <> v_generation.last_event_sequence + 1 then
    raise exception using errcode = 'P0001', message = format('Guest generation event sequence mismatch: expected %s received %s', v_generation.last_event_sequence + 1, p_sequence);
  end if;

  insert into public.guest_chat_generation_events (
    generation_id, user_id, sequence, event_type, event_payload
  ) values (
    p_generation_id, p_owner_key_hash, p_sequence, left(coalesce(p_event_type, 'generation_event'), 128), p_event_payload
  ) returning * into v_event;

  update public.guest_chat_generations
  set partial_text = coalesce(p_partial_text, partial_text),
      tokens_generated = case when p_tokens_generated is null then tokens_generated else greatest(0, p_tokens_generated) end,
      last_event_sequence = p_sequence,
      status = coalesce(p_status, status),
      error_code = case when p_error_code is null then error_code else left(p_error_code, 512) end,
      updated_at = now()
  where id = p_generation_id
    and user_id = p_owner_key_hash
    and execution_lease_id = p_lease_id;

  return v_event;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'Guest generation event sequence already exists';
end;
$$;

revoke all on function public.append_guest_chat_generation_event_fenced(text,uuid,uuid,integer,text,jsonb,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.append_guest_chat_generation_event_fenced(text,uuid,uuid,integer,text,jsonb,text,integer,text,text) to service_role;
