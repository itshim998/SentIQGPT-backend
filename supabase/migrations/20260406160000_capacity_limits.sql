-- ═══════════════════════════════════════════════════════════════════════════════
-- SentIQGPT Capacity Limits Migration
-- 
-- This migration adds database-level enforcement for capacity limits:
--   1. MAX 50 conversations per user (auto-delete oldest)
--   2. MAX 25KB memory storage per user (reject if exceeded)
--
-- RUN ON: Database 2, 3, 4 (Data shards only, NOT on Control DB 1)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- CONVERSATION LIMIT TRIGGER
-- Automatically deletes oldest conversations when user exceeds 50
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.enforce_conversation_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    max_conversations constant integer := 50;
    conversation_count integer;
    oldest_conversation_id uuid;
begin
    -- Count existing conversations for this user
    select count(*) into conversation_count
    from public.conversations
    where user_id = new.user_id;

    -- If at or over limit, delete the oldest conversation(s)
    while conversation_count >= max_conversations loop
        select id into oldest_conversation_id
        from public.conversations
        where user_id = new.user_id
        order by created_at asc
        limit 1;

        if oldest_conversation_id is not null then
            delete from public.conversations
            where id = oldest_conversation_id;
            
            conversation_count := conversation_count - 1;
        else
            exit; -- Safety exit if no conversation found
        end if;
    end loop;

    return new;
end;
$$;

drop trigger if exists enforce_conversation_limit_trigger on public.conversations;
create trigger enforce_conversation_limit_trigger
    before insert on public.conversations
    for each row
    execute function public.enforce_conversation_limit();

-- ═══════════════════════════════════════════════════════════════════════════════
-- MEMORY SIZE LIMIT TRIGGER
-- Rejects memory insert if user's total memory storage would exceed 25KB
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.enforce_memory_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    max_memory_bytes constant integer := 25 * 1024; -- 25 KB
    current_memory_bytes integer;
    new_memory_bytes integer;
begin
    -- Calculate current total memory size for this user (sum of summary lengths in bytes)
    select coalesce(sum(octet_length(summary)), 0) into current_memory_bytes
    from public.memories
    where user_id = new.user_id;

    -- Calculate new memory size
    new_memory_bytes := coalesce(octet_length(new.summary), 0);

    -- Check if adding this memory would exceed the limit
    if (current_memory_bytes + new_memory_bytes) > max_memory_bytes then
        raise exception 'Memory storage limit exceeded. Current: %KB, New: %KB, Limit: %KB',
            round(current_memory_bytes / 1024.0, 2),
            round(new_memory_bytes / 1024.0, 2),
            round(max_memory_bytes / 1024.0, 2);
    end if;

    return new;
end;
$$;

drop trigger if exists enforce_memory_limit_trigger on public.memories;
create trigger enforce_memory_limit_trigger
    before insert on public.memories
    for each row
    execute function public.enforce_memory_limit();

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTION: Get user's current memory usage
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.get_user_memory_usage(p_user_id uuid)
returns table(
    memory_count integer,
    total_bytes integer,
    total_kb numeric,
    limit_kb numeric,
    usage_percent numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    max_memory_bytes constant integer := 25 * 1024;
begin
    return query
    select
        count(*)::integer as memory_count,
        coalesce(sum(octet_length(summary)), 0)::integer as total_bytes,
        round(coalesce(sum(octet_length(summary)), 0) / 1024.0, 2) as total_kb,
        round(max_memory_bytes / 1024.0, 2) as limit_kb,
        round(coalesce(sum(octet_length(summary)), 0) * 100.0 / max_memory_bytes, 2) as usage_percent
    from public.memories
    where user_id = p_user_id;
end;
$$;

-- Grant execute to service_role only
revoke all on function public.get_user_memory_usage(uuid) from public;
revoke all on function public.get_user_memory_usage(uuid) from anon;
revoke all on function public.get_user_memory_usage(uuid) from authenticated;
grant execute on function public.get_user_memory_usage(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTION: Get user's conversation count
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.get_user_conversation_count(p_user_id uuid)
returns table(
    conversation_count integer,
    limit_count integer,
    usage_percent numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    max_conversations constant integer := 50;
begin
    return query
    select
        count(*)::integer as conversation_count,
        max_conversations as limit_count,
        round(count(*) * 100.0 / max_conversations, 2) as usage_percent
    from public.conversations
    where user_id = p_user_id;
end;
$$;

-- Grant execute to service_role only
revoke all on function public.get_user_conversation_count(uuid) from public;
revoke all on function public.get_user_conversation_count(uuid) from anon;
revoke all on function public.get_user_conversation_count(uuid) from authenticated;
grant execute on function public.get_user_conversation_count(uuid) to service_role;
