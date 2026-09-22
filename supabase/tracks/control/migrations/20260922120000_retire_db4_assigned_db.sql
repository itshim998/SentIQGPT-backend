-- Retire DB4 and restrict user_db_map assignment to DB2 and DB3 only
--
-- RUN ON: Database 1 (Control DB only)

do $$
declare
    db4_count integer;
begin
    select count(*)
    into db4_count
    from public.user_db_map
    where assigned_db = 4;

    if db4_count > 0 then
        raise exception 'Cannot tighten assigned_db constraint to [2, 3]: % rows with assigned_db=4 exist in user_db_map. Run cleanup script to reassign or remove DB4 mappings before applying this migration.', db4_count;
    end if;
end $$;

alter table public.user_db_map
drop constraint if exists user_db_map_assigned_db_check;

alter table public.user_db_map
add constraint user_db_map_assigned_db_check
check (assigned_db between 2 and 3);

comment on constraint user_db_map_assigned_db_check on public.user_db_map is
  'Ensures assigned_db routes only to active data shards (DB2 and DB3). DB4 was retired on 2026-09-22.';
