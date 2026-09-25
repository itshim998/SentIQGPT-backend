-- Restrict user_db_map assignment to data shards only
--
-- RUN ON: Database 1 (Control DB only)

do $$
declare
    invalid_count integer;
begin
    select count(*)
    into invalid_count
    from public.user_db_map
    where assigned_db = 1;

    if invalid_count > 0 then
        raise exception 'Cannot tighten assigned_db constraint: % rows with assigned_db=1 exist in user_db_map. Remediate these rows before applying this migration.', invalid_count;
    end if;
end $$;

alter table public.user_db_map
drop constraint if exists user_db_map_assigned_db_check;

alter table public.user_db_map
add constraint user_db_map_assigned_db_check
check (assigned_db between 2 and 4);
