-- Phase 19/20: canonical generation events + per-user concurrency control.

create table if not exists public.chat_generation_event_types (
  generation_id uuid primary key references public.chat_generations(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The event log itself remains process-local in this phase; this table is a small
-- authoritative marker that lets schema verification confirm the generation event
-- contract exists without duplicating the live event stream.
alter table public.chat_generations
  add column if not exists conversation_id uuid;

create index if not exists chat_generations_user_active_idx
  on public.chat_generations (user_id, status, execution_lease_expires_at)
  where status in ('running','waiting_for_tool','generating','persisting','cancel_requested');

create or replace function public.claim_chat_generation_execution(
  p_user_id uuid,
  p_generation_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 60,
  p_max_active_generations integer default 3
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
  v_limit integer := greatest(1, p_max_active_generations);
  v_active integer;
begin
  -- Serialize slot acquisition per user. This prevents two backend instances
  -- from simultaneously observing the same free slot and both starting work.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*)::integer
    into v_active
  from public.chat_generations g
  where g.user_id = p_user_id
    and g.id <> p_generation_id
    and g.status in ('running','waiting_for_tool','generating','persisting','cancel_requested')
    and (
      g.execution_lease_expires_at is null
      or g.execution_lease_expires_at > v_now
    );

  if v_active >= v_limit then
    raise exception using
      errcode = '55P03',
      message = format('Generation concurrency limit reached: %s active generations for user', v_limit),
      detail = format('max_active_generations=%s active_generations=%s', v_limit, v_active);
  end if;

  update public.chat_generations
  set execution_lease_id = p_lease_id,
      execution_lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
      status = case when status = 'cancel_requested' then 'cancel_requested' else 'running' end,
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

  insert into public.chat_generation_event_types (generation_id)
  values (p_generation_id)
  on conflict (generation_id) do nothing;

  return v_row;
end;
$$;

revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer) from public;
revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer) from anon;
revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer) from authenticated;
revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer,integer) from public;
revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer,integer) from anon;
revoke all on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer,integer) from authenticated;
grant execute on function public.claim_chat_generation_execution(uuid,uuid,uuid,integer,integer) to service_role;

alter table public.chat_generation_event_types enable row level security;
drop policy if exists "chat_generation_event_types_service_only" on public.chat_generation_event_types;
create policy "chat_generation_event_types_service_only" on public.chat_generation_event_types for all using (false) with check (false);
revoke all on table public.chat_generation_event_types from public;
revoke all on table public.chat_generation_event_types from anon;
revoke all on table public.chat_generation_event_types from authenticated;
grant all on table public.chat_generation_event_types to service_role;
