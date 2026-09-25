-- Durable automatic-memory idempotency
--
-- RUN ON: Database 2, 3, 4 (data shards only, NOT on Control DB 1)

alter table public.memories
add column if not exists automatic_idempotency_key text null;

create unique index if not exists idx_memories_user_automatic_idempotency_key
on public.memories (user_id, automatic_idempotency_key)
where automatic_idempotency_key is not null;

create or replace function public.insert_automatic_memory_once(
    p_user_id uuid,
    p_type text,
    p_summary text,
    p_importance integer,
    p_embedding jsonb,
    p_embedding_model text,
    p_embedding_created_at timestamptz,
    p_scope text,
    p_chat_id uuid,
    p_automatic_idempotency_key text
)
returns table(
    id uuid,
    user_id uuid,
    type text,
    summary text,
    importance integer,
    embedding jsonb,
    embedding_model text,
    embedding_created_at timestamptz,
    scope text,
    chat_id uuid,
    created_at timestamptz,
    deduplicated boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    existing public.memories%rowtype;
    inserted public.memories%rowtype;
begin
    if p_automatic_idempotency_key is null
       or p_automatic_idempotency_key !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid automatic memory idempotency key';
    end if;
    if p_scope not in ('global', 'chat') then
        raise exception 'Invalid automatic memory scope';
    end if;
    if p_scope = 'chat' and (
        p_chat_id is null
        or not exists (
            select 1 from public.conversations c
            where c.id = p_chat_id and c.user_id = p_user_id
        )
    ) then
        raise exception 'Invalid automatic memory conversation';
    end if;

    perform public.ensure_user_exists(p_user_id);
    perform 1 from public.users where users.id = p_user_id for update;

    select m.* into existing
    from public.memories m
    where m.user_id = p_user_id
      and m.automatic_idempotency_key = p_automatic_idempotency_key;

    if found then
        return query select
            existing.id, existing.user_id, existing.type, existing.summary,
            existing.importance, existing.embedding, existing.embedding_model,
            existing.embedding_created_at, existing.scope, existing.chat_id,
            existing.created_at, true;
        return;
    end if;

    insert into public.memories (
        user_id, type, summary, importance, embedding, embedding_model,
        embedding_created_at, scope, chat_id, automatic_idempotency_key
    ) values (
        p_user_id, p_type, p_summary, p_importance, p_embedding, p_embedding_model,
        p_embedding_created_at, p_scope,
        case when p_scope = 'chat' then p_chat_id else null end,
        p_automatic_idempotency_key
    ) returning * into inserted;

    update public.users
    set user_memory_usage_bytes = greatest(
        coalesce(user_memory_usage_bytes, 0) + octet_length(inserted.summary),
        0
    )
    where users.id = p_user_id;

    return query select
        inserted.id, inserted.user_id, inserted.type, inserted.summary,
        inserted.importance, inserted.embedding, inserted.embedding_model,
        inserted.embedding_created_at, inserted.scope, inserted.chat_id,
        inserted.created_at, false;
end;
$$;

revoke all on function public.insert_automatic_memory_once(uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, text) from public;
revoke all on function public.insert_automatic_memory_once(uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, text) from anon;
revoke all on function public.insert_automatic_memory_once(uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, text) from authenticated;
grant execute on function public.insert_automatic_memory_once(uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, text) to service_role;

create or replace function public.get_automatic_memory_idempotency_schema_version()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select '20260715120000'::text;
$$;

revoke all on function public.get_automatic_memory_idempotency_schema_version() from public;
revoke all on function public.get_automatic_memory_idempotency_schema_version() from anon;
revoke all on function public.get_automatic_memory_idempotency_schema_version() from authenticated;
grant execute on function public.get_automatic_memory_idempotency_schema_version() to service_role;
