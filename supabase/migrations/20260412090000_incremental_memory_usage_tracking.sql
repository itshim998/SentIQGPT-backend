-- Incremental memory usage tracking
--
-- RUN ON: Database 2, 3, 4 (data shards only, NOT on Control DB 1)

alter table public.users
add column if not exists user_memory_usage_bytes bigint not null default 0;

update public.users
set user_memory_usage_bytes = 0
where user_memory_usage_bytes is null;

update public.users as u
set user_memory_usage_bytes = coalesce(m.total_bytes, 0)
from (
    select
        user_id,
        sum(octet_length(summary))::bigint as total_bytes
    from public.memories
    group by user_id
) as m
where u.id = m.user_id;

create or replace function public.adjust_user_memory_usage(p_user_id uuid, p_delta_bytes bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    updated_total bigint;
begin
    perform public.ensure_user_exists(p_user_id);

    update public.users
    set user_memory_usage_bytes = greatest(
        coalesce(user_memory_usage_bytes, 0) + coalesce(p_delta_bytes, 0),
        0
    )
    where id = p_user_id
    returning user_memory_usage_bytes into updated_total;

    return coalesce(updated_total, 0);
end;
$$;

revoke all on function public.adjust_user_memory_usage(uuid, bigint) from public;
revoke all on function public.adjust_user_memory_usage(uuid, bigint) from anon;
revoke all on function public.adjust_user_memory_usage(uuid, bigint) from authenticated;
grant execute on function public.adjust_user_memory_usage(uuid, bigint) to service_role;

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

    select coalesce(user_memory_usage_bytes, 0)
    into current_memory_bytes
    from public.users
    where id = new.user_id;

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
    perform public.ensure_user_exists(p_user_id);

    return query
    select
        count(m.id)::integer as memory_count,
        coalesce(u.user_memory_usage_bytes, 0)::integer as total_bytes,
        round(coalesce(u.user_memory_usage_bytes, 0) / 1024.0, 2) as total_kb,
        round(max_memory_bytes / 1024.0, 2) as limit_kb,
        round(coalesce(u.user_memory_usage_bytes, 0) * 100.0 / max_memory_bytes, 2) as usage_percent
    from public.users as u
    left join public.memories as m
        on m.user_id = u.id
    where u.id = p_user_id
    group by u.user_memory_usage_bytes;
end;
$$;
