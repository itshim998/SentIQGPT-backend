-- RUN ON: Database 2, 3, 4 (Data shards)
-- Provides a bounded conversation-list read that does not load every message row.

create index if not exists messages_conversation_created_at_idx
on public.messages (conversation_id, created_at desc);

create index if not exists messages_conversation_role_created_at_idx
on public.messages (conversation_id, role, created_at asc);

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
    c.last_activity_at,
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
  order by c.last_activity_at desc nulls last, c.created_at desc;
$$;

grant execute on function public.list_user_conversations(uuid) to service_role;
