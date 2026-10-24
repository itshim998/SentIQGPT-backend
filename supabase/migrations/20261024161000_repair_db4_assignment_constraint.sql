-- CONTROL_ONLY: DB1 only. Forward repair; never replay retirement history.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regclass('public.billing_plans') is null or to_regclass('public.user_db_map') is null
     or to_regclass('public.chat_images') is not null then raise exception 'control database required'; end if;
  if not exists(select 1 from supabase_migrations.schema_migrations where version='20260922120000')
     or not exists(select 1 from supabase_migrations.schema_migrations where version='20261024120000') then
    raise exception 'control migration prerequisites missing'; end if;
end $$;
-- Lock before validation: no mapping write may race the check and replacement.
lock table public.user_db_map in access exclusive mode;
do $$ begin
  if not exists(select 1 from pg_attribute where attrelid='public.user_db_map'::regclass
      and attname='assigned_db' and atttypid='integer'::regtype and attnotnull and not attisdropped)
     or not exists(select 1 from pg_constraint where conrelid='public.user_db_map'::regclass
       and conname='user_db_map_assigned_db_check' and contype='c' and convalidated
       and pg_get_constraintdef(oid) in ('CHECK (((assigned_db >= 2) AND (assigned_db <= 4)))',
         'CHECK (((assigned_db >= 2) AND (assigned_db <= 3)))')) then
    raise exception 'unexpected assignment schema'; end if;
  if exists(select 1 from public.user_db_map where assigned_db is null or assigned_db not in (2,3)) then
    raise exception 'invalid user mappings prevent DB4 repair'; end if;
end $$;
alter table public.user_db_map drop constraint user_db_map_assigned_db_check;
alter table public.user_db_map add constraint user_db_map_assigned_db_check check (assigned_db between 2 and 3);
comment on constraint user_db_map_assigned_db_check on public.user_db_map is
  'Routes only to active data shards DB2 and DB3; forward repair of historical DB4 constraint drift.';
commit;
