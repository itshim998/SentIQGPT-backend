alter table public.users
drop constraint if exists users_id_fkey;

create or replace function public.ensure_user_exists(user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.users (id)
    values (user_id)
    on conflict (id) do nothing;
end;
$$;

create or replace function public.ensure_daily_usage_row(user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.ensure_user_exists(user_id);

    insert into public.usage_logs (user_id, date)
    values (user_id, current_date)
    on conflict (user_id, date) do nothing;
end;
$$;

create or replace function public.initialize_user_session(user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.ensure_user_exists(user_id);
    perform public.ensure_daily_usage_row(user_id);
end;
$$;
