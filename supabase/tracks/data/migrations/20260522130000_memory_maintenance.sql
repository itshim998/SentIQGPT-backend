-- Memory maintenance metadata and repair helpers
--
-- RUN ON: Database 2, 3, 4 (data shards only, NOT on Control DB 1)

alter table public.memories
add column if not exists embedding_backfill_requested_at timestamptz,
add column if not exists embedding_backfill_attempts integer not null default 0,
add column if not exists embedding_backfill_last_attempt_at timestamptz,
add column if not exists embedding_backfill_error text;

create index if not exists idx_memories_embedding_backfill_queue
  on public.memories (user_id, embedding_backfill_requested_at asc, embedding_backfill_attempts asc)
  where embedding is null
    and embedding_backfill_requested_at is not null;

create or replace function public.repair_user_memory_usage(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    repaired_total bigint;
begin
    perform public.ensure_user_exists(p_user_id);

    select coalesce(sum(octet_length(summary)), 0)::bigint
    into repaired_total
    from public.memories
    where user_id = p_user_id;

    update public.users
    set user_memory_usage_bytes = repaired_total
    where id = p_user_id;

    return coalesce(repaired_total, 0);
end;
$$;

revoke all on function public.repair_user_memory_usage(uuid) from public;
revoke all on function public.repair_user_memory_usage(uuid) from anon;
revoke all on function public.repair_user_memory_usage(uuid) from authenticated;
grant execute on function public.repair_user_memory_usage(uuid) to service_role;
