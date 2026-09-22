-- P0-12: guest generations use a durable, auth-independent owner key.
-- Apply this migration to data shards 2, 3, and 4. Never apply to auth DB.

create table if not exists public.guest_chat_generations (
  id uuid primary key default gen_random_uuid(),
  conversation_id text,
  user_id text not null,
  client_request_id text,
  generation_session_id uuid,
  status text not null default 'queued',
  execution_mode text,
  model_route text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  error_code text,
  partial_text text not null default '',
  tokens_generated integer not null default 0,
  last_event_sequence integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  execution_snapshot jsonb not null default '{}'::jsonb,
  execution_lease_id uuid,
  execution_lease_expires_at timestamptz,
  recovery_attempts integer not null default 0,
  last_execution_error text
);

create unique index if not exists guest_chat_generations_owner_request_uidx
  on public.guest_chat_generations(user_id, client_request_id)
  where client_request_id is not null;

create index if not exists guest_chat_generations_owner_status_idx
  on public.guest_chat_generations(user_id, status, updated_at);

create index if not exists guest_chat_generations_lease_idx
  on public.guest_chat_generations(execution_lease_expires_at)
  where execution_lease_id is not null;

create table if not exists public.guest_chat_generation_events (
  generation_id uuid not null references public.guest_chat_generations(id) on delete cascade,
  user_id text not null,
  sequence integer not null,
  event_type text not null,
  event_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (generation_id, sequence)
);

create index if not exists guest_chat_generation_events_owner_generation_seq_idx
  on public.guest_chat_generation_events(user_id, generation_id, sequence);

alter table public.guest_chat_generations enable row level security;
alter table public.guest_chat_generation_events enable row level security;

drop policy if exists guest_chat_generations_service_only on public.guest_chat_generations;
create policy guest_chat_generations_service_only on public.guest_chat_generations
  for all using (false) with check (false);

drop policy if exists guest_chat_generation_events_service_only on public.guest_chat_generation_events;
create policy guest_chat_generation_events_service_only on public.guest_chat_generation_events
  for all using (false) with check (false);

revoke all on public.guest_chat_generations from public, anon, authenticated;
revoke all on public.guest_chat_generation_events from public, anon, authenticated;
grant all on public.guest_chat_generations to service_role;
grant all on public.guest_chat_generation_events to service_role;

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
  select count(*) into v_active
  from public.guest_chat_generations
  where user_id = p_owner_key_hash
    and status in ('queued','running','waiting_for_tool','generating','persisting')
    and (execution_lease_expires_at is null or execution_lease_expires_at > now());

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
    and (execution_lease_id is null or execution_lease_expires_at <= now())
  returning * into v_row;

  if not found then
    raise exception using errcode = '55P03', message = 'Guest generation execution lease unavailable';
  end if;
  return v_row;
end;
$$;

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
    raise exception using errcode = '40001', message = 'Guest generation execution lease lost';
  end if;
  return v_row;
end;
$$;

create or replace function public.release_guest_chat_generation_execution_lease(
  p_owner_key_hash text,
  p_generation_id uuid,
  p_lease_id uuid
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
  set execution_lease_id = null,
      execution_lease_expires_at = null,
      updated_at = now()
  where id = p_generation_id
    and user_id = p_owner_key_hash
    and execution_lease_id = p_lease_id
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.request_guest_chat_generation_cancel(
  p_owner_key_hash text,
  p_generation_id uuid
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
  set status = case when status in ('completed','failed','cancelled') then status else 'cancel_requested' end,
      updated_at = now()
  where id = p_generation_id
    and user_id = p_owner_key_hash
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.cancel_guest_chat_generation(
  p_owner_key_hash text,
  p_generation_id uuid
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
  set status = 'cancelled',
      cancelled_at = coalesce(cancelled_at, now()),
      execution_lease_id = null,
      execution_lease_expires_at = null,
      updated_at = now()
  where id = p_generation_id
    and user_id = p_owner_key_hash
    and status not in ('completed','failed','cancelled')
  returning * into v_row;
  return v_row;
end;
$$;

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
    raise exception using errcode = '40001', message = 'Guest generation execution lease lost';
  end if;

  if p_sequence <> v_generation.last_event_sequence + 1 then
    raise exception using errcode = '40001', message = format('Guest generation event sequence mismatch: expected %s received %s', v_generation.last_event_sequence + 1, p_sequence);
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
    raise exception using errcode = '40001', message = 'Guest generation event sequence already exists';
end;
$$;

revoke all on function public.claim_guest_chat_generation_execution(text,uuid,uuid,integer,integer) from public, anon, authenticated;
revoke all on function public.renew_guest_chat_generation_execution_lease(text,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.release_guest_chat_generation_execution_lease(text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.request_guest_chat_generation_cancel(text,uuid) from public, anon, authenticated;
revoke all on function public.cancel_guest_chat_generation(text,uuid) from public, anon, authenticated;
revoke all on function public.append_guest_chat_generation_event_fenced(text,uuid,uuid,integer,text,jsonb,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.claim_guest_chat_generation_execution(text,uuid,uuid,integer,integer) to service_role;
grant execute on function public.renew_guest_chat_generation_execution_lease(text,uuid,uuid,integer) to service_role;
grant execute on function public.release_guest_chat_generation_execution_lease(text,uuid,uuid) to service_role;
grant execute on function public.request_guest_chat_generation_cancel(text,uuid) to service_role;
grant execute on function public.cancel_guest_chat_generation(text,uuid) to service_role;
grant execute on function public.append_guest_chat_generation_event_fenced(text,uuid,uuid,integer,text,jsonb,text,integer,text,text) to service_role;
