-- User display-name profile fields
--
-- RUN ON: Database 1, 2, 3, 4 (Control DB + Data shards)

alter table public.users
add column if not exists display_name text;

alter table public.users
add column if not exists display_name_updated_at timestamptz;

update public.users
set display_name = null
where display_name is not null
  and btrim(display_name) = '';
