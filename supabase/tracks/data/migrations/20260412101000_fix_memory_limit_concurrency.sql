-- Fix memory-limit race by validating against locked live memory totals
--
-- RUN ON: Database 2, 3, 4 (data shards only, NOT on Control DB 1)

create or replace function public.enforce_memory_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    max_memory_bytes constant integer := 25 * 1024;
    current_memory_bytes bigint;
    new_memory_bytes bigint;
begin
    perform public.ensure_user_exists(new.user_id);

    -- Serialize per-user memory-limit checks.
    perform 1
    from public.users
    where id = new.user_id
    for update;

    -- Read current persisted memory bytes from source table, not stale counter.
    select coalesce(sum(octet_length(summary)), 0)::bigint
    into current_memory_bytes
    from public.memories
    where user_id = new.user_id;

    new_memory_bytes := coalesce(octet_length(new.summary), 0);

    if (current_memory_bytes + new_memory_bytes) > max_memory_bytes then
        raise exception 'Memory storage limit exceeded. Current: %KB, New: %KB, Limit: %KB',
            round(current_memory_bytes / 1024.0, 2),
            round(new_memory_bytes / 1024.0, 2),
            round(max_memory_bytes / 1024.0, 2);
    end if;

    return new;
end;
$$;
