-- SentIQ Chat — Phase 1/2: durable generation identity + state.
-- RUN ON: every data shard (Database 2, 3, 4).
--
-- A generation belongs to a single chat turn and is intentionally independent
-- from any HTTP/SSE subscriber. Closing an SSE connection MUST NOT mutate this
-- state or cancel the generation.

create table if not exists public.chat_generations (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  client_request_id text,
  status text not null default 'queued',
  execution_mode text,
  model_route text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  error_code text,
  partial_text text not null default '',
  tokens_generated bigint not null default 0,
  last_event_sequence bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_generations_status_check check (
    status in (
      'queued',
      'running',
      'completed',
      'failed',
      'cancel_requested',
      'cancelled',
      'waiting_for_tool',
      'generating',
      'persisting'
    )
  ),
  constraint chat_generations_execution_mode_check check (
    execution_mode is null or execution_mode in ('fast', 'intuitive')
  )
);

create unique index if not exists chat_generations_user_client_request_id_unique
  on public.chat_generations (user_id, client_request_id)
  where client_request_id is not null;

create index if not exists chat_generations_conversation_created_at_idx
  on public.chat_generations (conversation_id, created_at desc);

create index if not exists chat_generations_user_status_idx
  on public.chat_generations (user_id, status, created_at desc);

create index if not exists chat_generations_updated_at_idx
  on public.chat_generations (updated_at desc);

alter table public.messages
  add column if not exists generation_id uuid references public.chat_generations (id) on delete set null;

create index if not exists messages_generation_id_idx
  on public.messages (generation_id)
  where generation_id is not null;

alter table public.chat_generations enable row level security;

drop policy if exists "chat_generations_service_only" on public.chat_generations;
create policy "chat_generations_service_only"
on public.chat_generations
for all
using (false)
with check (false);

revoke all on table public.chat_generations from public;
revoke all on table public.chat_generations from anon;
revoke all on table public.chat_generations from authenticated;
grant all on table public.chat_generations to service_role;

-- Keep updated_at authoritative at the database boundary.
create or replace function public.touch_chat_generation_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.touch_chat_generation_updated_at() from public;
revoke all on function public.touch_chat_generation_updated_at() from anon;
revoke all on function public.touch_chat_generation_updated_at() from authenticated;
grant execute on function public.touch_chat_generation_updated_at() to service_role;

drop trigger if exists chat_generations_touch_updated_at on public.chat_generations;
create trigger chat_generations_touch_updated_at
before update on public.chat_generations
for each row
execute function public.touch_chat_generation_updated_at();

-- Phase 1 identity bridge:
-- user-authored chat turns create the durable generation row before model work.
-- No transport lifecycle is involved here.
create or replace function public.ensure_chat_generation_for_user_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_generation_id uuid;
begin
  if new.role <> 'user' or nullif(btrim(coalesce(new.client_request_id, '')), '') is null then
    return new;
  end if;

  select c.user_id
    into v_user_id
  from public.conversations c
  where c.id = new.conversation_id;

  if v_user_id is null then
    return new;
  end if;

  insert into public.chat_generations (
    conversation_id,
    user_id,
    client_request_id,
    status,
    started_at
  )
  values (
    new.conversation_id,
    v_user_id,
    nullif(btrim(new.client_request_id), ''),
    'running',
    now()
  )
  on conflict (user_id, client_request_id) do update
    set status = case
      when public.chat_generations.status = 'queued' then 'running'
      else public.chat_generations.status
    end,
    started_at = coalesce(public.chat_generations.started_at, now());

  select cg.id
    into v_generation_id
  from public.chat_generations cg
  where cg.user_id = v_user_id
    and cg.client_request_id = nullif(btrim(new.client_request_id), '');

  -- The user message itself does not need generation_id, but keeping the
  -- generation association recoverable from the request ID makes duplicate
  -- and retry paths deterministic.
  perform v_generation_id;
  return new;
end;
$$;

revoke all on function public.ensure_chat_generation_for_user_message() from public;
revoke all on function public.ensure_chat_generation_for_user_message() from anon;
revoke all on function public.ensure_chat_generation_for_user_message() from authenticated;
grant execute on function public.ensure_chat_generation_for_user_message() to service_role;

drop trigger if exists messages_ensure_chat_generation on public.messages;
create trigger messages_ensure_chat_generation
after insert on public.messages
for each row
execute function public.ensure_chat_generation_for_user_message();

-- Phase 2 settlement bridge:
-- assistant persistence completes the generation and stamps the immutable
-- generation_id onto the assistant message. This trigger never cancels a
-- generation because an SSE subscriber disappeared.
create or replace function public.settle_chat_generation_from_assistant_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_generation_id uuid;
  v_client_request_id text := nullif(btrim(coalesce(new.client_request_id, '')), '');
  v_existing_status text;
begin
  if new.role <> 'assistant' or v_client_request_id is null then
    return new;
  end if;

  select c.user_id
    into v_user_id
  from public.conversations c
  where c.id = new.conversation_id;

  if v_user_id is null then
    return new;
  end if;

  select cg.id, cg.status
    into v_generation_id, v_existing_status
  from public.chat_generations cg
  where cg.user_id = v_user_id
    and cg.conversation_id = new.conversation_id
    and cg.client_request_id = v_client_request_id;

  if v_generation_id is null then
    insert into public.chat_generations (
      conversation_id,
      user_id,
      client_request_id,
      status,
      started_at,
      completed_at,
      partial_text
    )
    values (
      new.conversation_id,
      v_user_id,
      v_client_request_id,
      'completed',
      now(),
      now(),
      coalesce(new.content, '')
    )
    on conflict (user_id, client_request_id) do nothing
    returning id into v_generation_id;

    if v_generation_id is null then
      select cg.id, cg.status
        into v_generation_id, v_existing_status
      from public.chat_generations cg
      where cg.user_id = v_user_id
        and cg.client_request_id = v_client_request_id;
    else
      v_existing_status := 'completed';
    end if;
  end if;

  if v_generation_id is not null then
    new.generation_id := v_generation_id;

    update public.chat_generations cg
    set partial_text = coalesce(new.content, cg.partial_text),
        completed_at = case
          when cg.status in ('cancel_requested', 'cancelled') then cg.completed_at
          else coalesce(cg.completed_at, now())
        end,
        status = case
          when cg.status in ('cancel_requested', 'cancelled') then cg.status
          else 'completed'
        end,
        error_code = case
          when cg.status in ('cancel_requested', 'cancelled') then cg.error_code
          else null
        end
    where cg.id = v_generation_id;
  end if;

  return new;
end;
$$;

revoke all on function public.settle_chat_generation_from_assistant_message() from public;
revoke all on function public.settle_chat_generation_from_assistant_message() from anon;
revoke all on function public.settle_chat_generation_from_assistant_message() from authenticated;
grant execute on function public.settle_chat_generation_from_assistant_message() to service_role;

drop trigger if exists messages_settle_chat_generation on public.messages;
create trigger messages_settle_chat_generation
before insert on public.messages
for each row
execute function public.settle_chat_generation_from_assistant_message();

-- Explicit lifecycle mutation APIs for the upcoming generation executor.
-- Importantly, there is no API here that maps subscriber disconnect -> cancel.
create or replace function public.request_chat_generation_cancel(
  p_user_id uuid,
  p_generation_id uuid
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
  set status = case
    when status in ('completed', 'failed', 'cancelled') then status
    else 'cancel_requested'
  end
  where id = p_generation_id
    and user_id = p_user_id
  returning * into v_row;

  if not found then
    raise exception 'Chat generation not found';
  end if;

  return v_row;
end;
$$;

create or replace function public.cancel_chat_generation(
  p_user_id uuid,
  p_generation_id uuid
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
  set status = case
      when status in ('completed', 'failed') then status
      else 'cancelled'
    end,
    cancelled_at = case
      when status in ('completed', 'failed') then cancelled_at
      else coalesce(cancelled_at, now())
    end
  where id = p_generation_id
    and user_id = p_user_id
  returning * into v_row;

  if not found then
    raise exception 'Chat generation not found';
  end if;

  return v_row;
end;
$$;

revoke all on function public.request_chat_generation_cancel(uuid, uuid) from public;
revoke all on function public.request_chat_generation_cancel(uuid, uuid) from anon;
revoke all on function public.request_chat_generation_cancel(uuid, uuid) from authenticated;
grant execute on function public.request_chat_generation_cancel(uuid, uuid) to service_role;

revoke all on function public.cancel_chat_generation(uuid, uuid) from public;
revoke all on function public.cancel_chat_generation(uuid, uuid) from anon;
revoke all on function public.cancel_chat_generation(uuid, uuid) from authenticated;
grant execute on function public.cancel_chat_generation(uuid, uuid) to service_role;
