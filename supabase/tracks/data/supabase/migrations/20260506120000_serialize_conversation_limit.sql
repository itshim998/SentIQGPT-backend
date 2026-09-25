-- Serialize per-user conversation-limit enforcement.
--
-- RUN ON: Database 2, 3, 4 (data shards only, NOT on Control DB 1)

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
    perform public.ensure_user_exists(new.user_id);

    -- Serialize concurrent conversation inserts for the same user so two
    -- requests cannot both pass the count check before either insert lands.
    perform 1
    from public.users
    where id = new.user_id
    for update;

    select count(*) into conversation_count
    from public.conversations
    where user_id = new.user_id;

    while conversation_count >= max_conversations loop
        select id into oldest_conversation_id
        from public.conversations
        where user_id = new.user_id
        order by created_at asc
        limit 1;

        if oldest_conversation_id is null then
            exit;
        end if;

        delete from public.conversations
        where id = oldest_conversation_id;

        conversation_count := conversation_count - 1;
    end loop;

    return new;
end;
$$;
