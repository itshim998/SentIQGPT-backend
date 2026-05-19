-- RUN ON: Database 2, 3, 4 (data shards).
-- Adds canonical conversation resolution for chat-turn idempotency and
-- safe duplicate conversation merges.

create table if not exists public.conversation_turn_requests (
  user_id uuid not null references public.users (id) on delete cascade,
  client_request_id text not null,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_request_id)
);

create index if not exists conversation_turn_requests_conversation_id_idx
  on public.conversation_turn_requests (conversation_id);

create table if not exists public.conversation_aliases (
  old_conversation_id uuid primary key,
  canonical_conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  reason text not null default 'duplicate_merge',
  created_at timestamptz not null default now()
);

create index if not exists conversation_aliases_user_id_idx
  on public.conversation_aliases (user_id);

create index if not exists conversation_aliases_canonical_conversation_id_idx
  on public.conversation_aliases (canonical_conversation_id);

create table if not exists public.conversation_merge_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  canonical_conversation_id uuid not null references public.conversations (id) on delete cascade,
  duplicate_conversation_id uuid not null,
  reason text not null,
  messages_moved integer not null default 0,
  messages_deleted integer not null default 0,
  images_moved integer not null default 0,
  generated_files_moved integer not null default 0,
  memories_moved integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists conversation_merge_audit_user_id_created_at_idx
  on public.conversation_merge_audit (user_id, created_at desc);

alter table public.conversation_turn_requests enable row level security;
alter table public.conversation_aliases enable row level security;
alter table public.conversation_merge_audit enable row level security;

drop policy if exists "conversation_turn_requests_service_only" on public.conversation_turn_requests;
create policy "conversation_turn_requests_service_only"
on public.conversation_turn_requests
for all
using (false)
with check (false);

drop policy if exists "conversation_aliases_service_only" on public.conversation_aliases;
create policy "conversation_aliases_service_only"
on public.conversation_aliases
for all
using (false)
with check (false);

drop policy if exists "conversation_merge_audit_service_only" on public.conversation_merge_audit;
create policy "conversation_merge_audit_service_only"
on public.conversation_merge_audit
for all
using (false)
with check (false);

revoke all on table public.conversation_turn_requests from public;
revoke all on table public.conversation_turn_requests from anon;
revoke all on table public.conversation_turn_requests from authenticated;
grant all on table public.conversation_turn_requests to service_role;

revoke all on table public.conversation_aliases from public;
revoke all on table public.conversation_aliases from anon;
revoke all on table public.conversation_aliases from authenticated;
grant all on table public.conversation_aliases to service_role;

revoke all on table public.conversation_merge_audit from public;
revoke all on table public.conversation_merge_audit from anon;
revoke all on table public.conversation_merge_audit from authenticated;
grant all on table public.conversation_merge_audit to service_role;

create or replace function public.resolve_conversation_for_turn(
  p_user_id uuid,
  p_client_request_id text,
  p_requested_conversation_id uuid default null,
  p_title text default 'New Chat'
)
returns table(
  conversation_id uuid,
  title text,
  created_at timestamptz,
  last_activity_at timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id text := nullif(btrim(coalesce(p_client_request_id, '')), '');
  v_title text := left(coalesce(nullif(btrim(p_title), ''), 'New Chat'), 120);
  v_requested_id uuid := p_requested_conversation_id;
  v_mapped_id uuid;
  v_row public.conversations%rowtype;
  v_created boolean := false;
  v_inserted_count integer := 0;
begin
  perform public.ensure_user_exists(p_user_id);

  if v_requested_id is not null then
    select ca.canonical_conversation_id
      into v_mapped_id
    from public.conversation_aliases ca
    where ca.user_id = p_user_id
      and ca.old_conversation_id = v_requested_id;

    if v_mapped_id is not null then
      v_requested_id := v_mapped_id;
    end if;
  end if;

  if v_request_id is not null then
    select ctr.conversation_id
      into v_mapped_id
    from public.conversation_turn_requests ctr
    where ctr.user_id = p_user_id
      and ctr.client_request_id = v_request_id;

    if v_mapped_id is not null then
      select *
        into v_row
      from public.conversations c
      where c.id = v_mapped_id
        and c.user_id = p_user_id;

      if found then
        conversation_id := v_row.id;
        title := v_row.title;
        created_at := v_row.created_at;
        last_activity_at := v_row.last_activity_at;
        created := false;
        return next;
        return;
      end if;

      delete from public.conversation_turn_requests
      where user_id = p_user_id
        and client_request_id = v_request_id;
    end if;
  end if;

  if v_requested_id is null then
    v_requested_id := gen_random_uuid();
  end if;

  insert into public.conversations (id, user_id, title)
  values (v_requested_id, p_user_id, v_title)
  on conflict (id) do nothing;

  get diagnostics v_inserted_count = row_count;
  v_created := v_inserted_count > 0;

  select *
    into v_row
  from public.conversations c
  where c.id = v_requested_id;

  if not found then
    raise exception 'Failed to resolve conversation %', v_requested_id;
  end if;

  if v_row.user_id <> p_user_id then
    raise exception 'Conversation id % belongs to another user', v_requested_id
      using errcode = '42501';
  end if;

  if v_request_id is not null then
    insert into public.conversation_turn_requests (user_id, client_request_id, conversation_id)
    values (p_user_id, v_request_id, v_requested_id)
    on conflict (user_id, client_request_id) do nothing;

    select ctr.conversation_id
      into v_mapped_id
    from public.conversation_turn_requests ctr
    where ctr.user_id = p_user_id
      and ctr.client_request_id = v_request_id;

    if v_mapped_id is not null and v_mapped_id <> v_requested_id then
      delete from public.conversations c
      where c.id = v_requested_id
        and c.user_id = p_user_id
        and not exists (
          select 1
          from public.messages m
          where m.conversation_id = v_requested_id
        );

      select *
        into v_row
      from public.conversations c
      where c.id = v_mapped_id
        and c.user_id = p_user_id;

      if not found then
        raise exception 'Mapped conversation % was not found', v_mapped_id;
      end if;
    end if;
  end if;

  conversation_id := v_row.id;
  title := v_row.title;
  created_at := v_row.created_at;
  last_activity_at := v_row.last_activity_at;
  created := v_created;
  return next;
end;
$$;

revoke all on function public.resolve_conversation_for_turn(uuid, text, uuid, text) from public;
revoke all on function public.resolve_conversation_for_turn(uuid, text, uuid, text) from anon;
revoke all on function public.resolve_conversation_for_turn(uuid, text, uuid, text) from authenticated;
grant execute on function public.resolve_conversation_for_turn(uuid, text, uuid, text) to service_role;

create or replace function public.merge_duplicate_conversation(
  p_user_id uuid,
  p_canonical_conversation_id uuid,
  p_duplicate_conversation_id uuid,
  p_reason text default 'duplicate_merge'
)
returns table(
  canonical_conversation_id uuid,
  duplicate_conversation_id uuid,
  messages_moved integer,
  messages_deleted integer,
  images_moved integer,
  generated_files_moved integer,
  memories_moved integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_canonical public.conversations%rowtype;
  v_duplicate public.conversations%rowtype;
  v_messages_moved integer := 0;
  v_messages_deleted integer := 0;
  v_images_moved integer := 0;
  v_generated_files_moved integer := 0;
  v_memories_moved integer := 0;
begin
  if p_canonical_conversation_id = p_duplicate_conversation_id then
    raise exception 'Canonical and duplicate conversation ids must differ';
  end if;

  select *
    into v_canonical
  from public.conversations
  where id = p_canonical_conversation_id
    and user_id = p_user_id;

  if not found then
    raise exception 'Canonical conversation not found';
  end if;

  select *
    into v_duplicate
  from public.conversations
  where id = p_duplicate_conversation_id
    and user_id = p_user_id;

  if not found then
    raise exception 'Duplicate conversation not found';
  end if;

  insert into public.conversation_aliases (
    old_conversation_id,
    canonical_conversation_id,
    user_id,
    reason
  )
  values (
    p_duplicate_conversation_id,
    p_canonical_conversation_id,
    p_user_id,
    coalesce(nullif(btrim(p_reason), ''), 'duplicate_merge')
  )
  on conflict (old_conversation_id) do update
    set canonical_conversation_id = excluded.canonical_conversation_id,
        user_id = excluded.user_id,
        reason = excluded.reason,
        created_at = now();

  update public.conversation_aliases
  set canonical_conversation_id = p_canonical_conversation_id
  where user_id = p_user_id
    and canonical_conversation_id = p_duplicate_conversation_id;

  update public.conversation_turn_requests
  set conversation_id = p_canonical_conversation_id
  where user_id = p_user_id
    and conversation_id = p_duplicate_conversation_id;

  delete from public.messages d
  using public.messages c
  where d.conversation_id = p_duplicate_conversation_id
    and c.conversation_id = p_canonical_conversation_id
    and d.role = c.role
    and coalesce(d.message_type, 'text') = coalesce(c.message_type, 'text')
    and (
      (
        d.client_request_id is not null
        and c.client_request_id = d.client_request_id
      )
      or (
        d.client_request_id is null
        and c.client_request_id is null
        and lower(regexp_replace(coalesce(d.content, ''), '[[:space:]]+', ' ', 'g'))
          = lower(regexp_replace(coalesce(c.content, ''), '[[:space:]]+', ' ', 'g'))
      )
    );

  get diagnostics v_messages_deleted = row_count;

  update public.messages
  set conversation_id = p_canonical_conversation_id
  where conversation_id = p_duplicate_conversation_id;

  get diagnostics v_messages_moved = row_count;

  update public.chat_images
  set chat_id = p_canonical_conversation_id
  where user_id = p_user_id
    and chat_id = p_duplicate_conversation_id;

  get diagnostics v_images_moved = row_count;

  update public.generated_files
  set chat_id = p_canonical_conversation_id
  where user_id = p_user_id
    and chat_id = p_duplicate_conversation_id;

  get diagnostics v_generated_files_moved = row_count;

  update public.memories
  set chat_id = p_canonical_conversation_id
  where user_id = p_user_id
    and chat_id = p_duplicate_conversation_id;

  get diagnostics v_memories_moved = row_count;

  update public.conversations
  set last_activity_at = greatest(
    coalesce(v_canonical.last_activity_at, v_canonical.created_at),
    coalesce(v_duplicate.last_activity_at, v_duplicate.created_at)
  )
  where id = p_canonical_conversation_id
    and user_id = p_user_id;

  delete from public.conversations
  where id = p_duplicate_conversation_id
    and user_id = p_user_id;

  insert into public.conversation_merge_audit (
    user_id,
    canonical_conversation_id,
    duplicate_conversation_id,
    reason,
    messages_moved,
    messages_deleted,
    images_moved,
    generated_files_moved,
    memories_moved
  )
  values (
    p_user_id,
    p_canonical_conversation_id,
    p_duplicate_conversation_id,
    coalesce(nullif(btrim(p_reason), ''), 'duplicate_merge'),
    v_messages_moved,
    v_messages_deleted,
    v_images_moved,
    v_generated_files_moved,
    v_memories_moved
  );

  canonical_conversation_id := p_canonical_conversation_id;
  duplicate_conversation_id := p_duplicate_conversation_id;
  messages_moved := v_messages_moved;
  messages_deleted := v_messages_deleted;
  images_moved := v_images_moved;
  generated_files_moved := v_generated_files_moved;
  memories_moved := v_memories_moved;
  return next;
end;
$$;

revoke all on function public.merge_duplicate_conversation(uuid, uuid, uuid, text) from public;
revoke all on function public.merge_duplicate_conversation(uuid, uuid, uuid, text) from anon;
revoke all on function public.merge_duplicate_conversation(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.merge_duplicate_conversation(uuid, uuid, uuid, text) to service_role;
