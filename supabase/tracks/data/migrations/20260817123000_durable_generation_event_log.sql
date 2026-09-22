-- P0-5/P0-8: durable, replica-independent generation event log.
-- Every emitted sequenced event is persisted under the execution lease that owns it.
-- The same transaction advances chat_generations.last_event_sequence, so the
-- reconnect cursor can never permanently lag an event that was acknowledged.

create table if not exists public.chat_generation_events (
  generation_id uuid not null references public.chat_generations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  sequence integer not null,
  event_type text not null,
  event_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (generation_id, sequence)
);

create index if not exists chat_generation_events_user_generation_seq_idx
  on public.chat_generation_events (user_id, generation_id, sequence);

create index if not exists chat_generation_events_created_idx
  on public.chat_generation_events (created_at);

alter table public.chat_generation_events enable row level security;
drop policy if exists "chat_generation_events_service_only" on public.chat_generation_events;
create policy "chat_generation_events_service_only"
  on public.chat_generation_events
  for all using (false) with check (false);
revoke all on table public.chat_generation_events from public;
revoke all on table public.chat_generation_events from anon;
revoke all on table public.chat_generation_events from authenticated;
grant all on table public.chat_generation_events to service_role;

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
    raise exception using errcode = '40001', message = 'Generation execution lease lost';
  end if;

  if p_sequence <> v_generation.last_event_sequence + 1 then
    raise exception using
      errcode = '40001',
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
    raise exception using errcode = '40001', message = 'Generation event sequence already exists';
end;
$$;

revoke all on function public.append_chat_generation_event_fenced(uuid,uuid,uuid,integer,text,jsonb,text,integer,text,text) from public;
revoke all on function public.append_chat_generation_event_fenced(uuid,uuid,uuid,integer,text,jsonb,text,integer,text,text) from anon;
revoke all on function public.append_chat_generation_event_fenced(uuid,uuid,uuid,integer,text,jsonb,text,integer,text,text) from authenticated;
grant execute on function public.append_chat_generation_event_fenced(uuid,uuid,uuid,integer,text,jsonb,text,integer,text,text) to service_role;

-- Keep the active event history available for reconnects, but bound terminal
-- retention so long-running installations do not accumulate unbounded rows.
create or replace function public.prune_chat_generation_events(p_retention_seconds integer default 900)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.chat_generation_events e
  using public.chat_generations g
  where g.id = e.generation_id
    and g.status in ('completed','failed','cancelled')
    and g.updated_at < now() - make_interval(secs => greatest(60, p_retention_seconds));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

grant execute on function public.prune_chat_generation_events(integer) to service_role;
