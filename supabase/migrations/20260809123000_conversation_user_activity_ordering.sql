-- SentIQ Chat conversation ordering + retention hardening.
--
-- Product rule:
--   * A conversation is recent only when it was created or the USER wrote in it.
--   * Opening/reading, assistant output, title changes, hydration, and cache warming
--     never change sidebar recency.
--   * Keep at most 50 conversations. The least-recent conversation by the same
--     user-activity rule is evicted before the 51st insert.
--
-- RUN ON: Database 2, 3, 4 (data shards only; never the control database).

alter table public.conversations
  add column if not exists last_activity_at timestamptz;

-- Repair historical rows that may have been promoted by assistant messages or
-- older hydration behaviour. Recompute from USER-authored messages only.
update public.conversations c
set last_activity_at = coalesce(
  (
    select max(m.created_at)
    from public.messages m
    where m.conversation_id = c.id
      and m.role = 'user'
  ),
  c.created_at
);

create index if not exists conversations_user_last_activity_idx
  on public.conversations (user_id, last_activity_at desc, created_at desc);

-- Keep the existing trigger name for compatibility, but change its semantics:
-- only a user message is allowed to advance conversation activity.
create or replace function public.touch_conversation_last_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role = 'user' then
    update public.conversations
    set last_activity_at = greatest(
      coalesce(last_activity_at, created_at),
      coalesce(new.created_at, now())
    )
    where id = new.conversation_id;
  end if;

  return new;
end;
$$;

drop trigger if exists messages_touch_conversation_last_activity on public.messages;
create trigger messages_touch_conversation_last_activity
after insert on public.messages
for each row
execute function public.touch_conversation_last_activity();

-- Sidebar list order is now strictly creation/latest-user-write activity.
-- last_message_at is still returned as metadata/evidence, but is intentionally
-- excluded from ordering and from last_activity_at fallback semantics.
create or replace function public.list_user_conversations(p_user_id uuid)
returns table (
  id uuid,
  title text,
  created_at timestamptz,
  last_activity_at timestamptz,
  message_count bigint,
  first_user_message text,
  last_message_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    c.title,
    c.created_at,
    coalesce(c.last_activity_at, c.created_at) as last_activity_at,
    coalesce(message_stats.message_count, 0)::bigint as message_count,
    left(first_user.content, 240) as first_user_message,
    last_message.created_at as last_message_at
  from public.conversations c
  left join lateral (
    select count(*)::bigint as message_count
    from public.messages m
    where m.conversation_id = c.id
  ) message_stats on true
  left join lateral (
    select m.content
    from public.messages m
    where m.conversation_id = c.id
      and m.role = 'user'
    order by m.created_at asc, m.id asc
    limit 1
  ) first_user on true
  left join lateral (
    select m.created_at
    from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) last_message on true
  where c.user_id = p_user_id
  order by
    coalesce(c.last_activity_at, c.created_at) desc,
    c.created_at desc,
    c.id desc;
$$;

revoke all on function public.list_user_conversations(uuid) from public;
revoke all on function public.list_user_conversations(uuid) from anon;
revoke all on function public.list_user_conversations(uuid) from authenticated;
grant execute on function public.list_user_conversations(uuid) to service_role;

-- Preserve the existing per-user serialization lock, but evict the BOTTOM chat
-- using the exact same user-activity ordering as the sidebar.
create or replace function public.enforce_conversation_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  max_conversations constant integer := 50;
  conversation_count integer;
  least_recent_conversation_id uuid;
begin
  perform public.ensure_user_exists(new.user_id);

  perform 1
  from public.users
  where id = new.user_id
  for update;

  select count(*)
  into conversation_count
  from public.conversations
  where user_id = new.user_id;

  while conversation_count >= max_conversations loop
    select c.id
    into least_recent_conversation_id
    from public.conversations c
    where c.user_id = new.user_id
    order by
      coalesce(c.last_activity_at, c.created_at) asc,
      c.created_at asc,
      c.id asc
    limit 1;

    if least_recent_conversation_id is null then
      exit;
    end if;

    delete from public.conversations
    where id = least_recent_conversation_id
      and user_id = new.user_id;

    conversation_count := conversation_count - 1;
  end loop;

  return new;
end;
$$;

-- The trigger already exists on deployed shards, but recreate it explicitly so
-- a fresh database receives the same contract when this migration is applied.
drop trigger if exists enforce_conversation_limit_trigger on public.conversations;
create trigger enforce_conversation_limit_trigger
before insert on public.conversations
for each row
execute function public.enforce_conversation_limit();

-- Post-migration invariant: no existing account may retain more than 50 rows.
-- If legacy data exceeds the cap, remove the least-recent rows by user activity.
with ranked as (
  select
    c.id,
    row_number() over (
      partition by c.user_id
      order by
        coalesce(c.last_activity_at, c.created_at) desc,
        c.created_at desc,
        c.id desc
    ) as recency_rank
  from public.conversations c
)
delete from public.conversations c
using ranked r
where c.id = r.id
  and r.recency_rank > 50;
