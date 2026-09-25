-- RUN ON: Database 2, 3, 4 (Data shards)
-- Standardizes conversation activity timestamps used by chat list ordering.

alter table public.conversations
  add column if not exists last_activity_at timestamptz;

update public.conversations c
set last_activity_at = coalesce(
  c.last_activity_at,
  (
    select max(m.created_at)
    from public.messages m
    where m.conversation_id = c.id
  ),
  c.created_at
)
where c.last_activity_at is null;

create index if not exists conversations_user_last_activity_idx
  on public.conversations (user_id, last_activity_at desc, created_at desc);

create or replace function public.touch_conversation_last_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.conversations
  set last_activity_at = greatest(
    coalesce(last_activity_at, created_at),
    coalesce(new.created_at, now())
  )
  where id = new.conversation_id;

  return new;
end;
$$;

drop trigger if exists messages_touch_conversation_last_activity on public.messages;
create trigger messages_touch_conversation_last_activity
after insert on public.messages
for each row
execute function public.touch_conversation_last_activity();

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
    coalesce(c.last_activity_at, last_message.created_at, c.created_at) as last_activity_at,
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
    order by m.created_at asc
    limit 1
  ) first_user on true
  left join lateral (
    select m.created_at
    from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) last_message on true
  where c.user_id = p_user_id
  order by coalesce(c.last_activity_at, last_message.created_at, c.created_at) desc, c.created_at desc;
$$;

grant execute on function public.list_user_conversations(uuid) to service_role;
