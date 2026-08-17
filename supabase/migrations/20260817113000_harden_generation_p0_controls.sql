-- P0 hardening: durable cancellation visibility and lease-fenced generation mutations.
-- A worker may mutate a generation only while it still owns the exact execution lease.

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
      errcode = '40001',
      message = 'Generation execution lease lost';
  end if;

  return v_row;
end;
$$;

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
      errcode = '40001',
      message = 'Generation execution lease lost';
  end if;

  return v_row;
end;
$$;

-- A session remains open during its reload grace window. Once that window
-- expires, make its active generations visibly cancellable in durable state so
-- the owning worker can observe the cancellation even on another replica.
create or replace function public.expire_stale_chat_generation_sessions(p_lease_seconds integer default 45)
returns table (session_id uuid, user_id uuid, anonymous_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with closed_sessions as (
    update public.chat_generation_sessions s
    set status = 'closed',
        closed_at = coalesce(s.closed_at, now())
    where s.status = 'open'
      and (
        (s.close_grace_expires_at is not null and s.close_grace_expires_at <= now())
        or s.last_heartbeat_at < now() - make_interval(secs => greatest(15, p_lease_seconds))
      )
    returning s.id, s.user_id, s.anonymous_id
  )
  update public.chat_generations g
  set status = 'cancel_requested'
  where g.generation_session_id in (select id from closed_sessions)
    and g.status in ('queued','running','waiting_for_tool','generating','persisting','recoverable')
  returning g.generation_session_id, g.user_id, null::text;
end;
$$;

revoke all on function public.checkpoint_chat_generation_fenced(uuid,uuid,uuid,text,integer,integer,text) from public;
revoke all on function public.checkpoint_chat_generation_fenced(uuid,uuid,uuid,text,integer,integer,text) from anon;
revoke all on function public.checkpoint_chat_generation_fenced(uuid,uuid,uuid,text,integer,integer,text) from authenticated;
grant execute on function public.checkpoint_chat_generation_fenced(uuid,uuid,uuid,text,integer,integer,text) to service_role;

revoke all on function public.finalize_chat_generation_fenced(uuid,uuid,uuid,text,text,text,integer,integer) from public;
revoke all on function public.finalize_chat_generation_fenced(uuid,uuid,uuid,text,text,text,integer,integer) from anon;
revoke all on function public.finalize_chat_generation_fenced(uuid,uuid,uuid,text,text,text,integer,integer) from authenticated;
grant execute on function public.finalize_chat_generation_fenced(uuid,uuid,uuid,text,text,text,integer,integer) to service_role;
