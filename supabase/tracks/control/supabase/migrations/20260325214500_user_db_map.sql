-- RUN ON: Database 1, 2, 3, 4 (Control DB + Data shards)

create table if not exists public.user_db_map (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references public.users (id) on delete cascade,
    assigned_db integer not null check (assigned_db between 1 and 4),
    created_at timestamptz not null default now()
);

create index if not exists user_db_map_user_id_idx on public.user_db_map (user_id);

alter table public.user_db_map enable row level security;

revoke all on table public.user_db_map from public;
revoke all on table public.user_db_map from anon;
revoke all on table public.user_db_map from authenticated;
grant all on table public.user_db_map to service_role;

create or replace function public.prevent_user_db_map_reassignment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if new.user_id is distinct from old.user_id then
        raise exception 'user_id cannot be changed once set';
    end if;

    if new.assigned_db is distinct from old.assigned_db then
        raise exception 'assigned_db cannot be changed once set';
    end if;

    return new;
end;
$$;

drop trigger if exists prevent_user_db_map_reassignment on public.user_db_map;
create trigger prevent_user_db_map_reassignment
before update on public.user_db_map
for each row
execute function public.prevent_user_db_map_reassignment();
