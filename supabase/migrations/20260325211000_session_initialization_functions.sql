create or replace function public.ensure_user_exists(user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.users (id)
    select user_id
    where exists (
        select 1
        from auth.users
        where id = user_id
    )
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

revoke all on function public.ensure_user_exists(uuid) from public;
revoke all on function public.ensure_user_exists(uuid) from anon;
revoke all on function public.ensure_user_exists(uuid) from authenticated;
grant execute on function public.ensure_user_exists(uuid) to service_role;

revoke all on function public.ensure_daily_usage_row(uuid) from public;
revoke all on function public.ensure_daily_usage_row(uuid) from anon;
revoke all on function public.ensure_daily_usage_row(uuid) from authenticated;
grant execute on function public.ensure_daily_usage_row(uuid) to service_role;

revoke all on function public.initialize_user_session(uuid) from public;
revoke all on function public.initialize_user_session(uuid) from anon;
revoke all on function public.initialize_user_session(uuid) from authenticated;
grant execute on function public.initialize_user_session(uuid) to service_role;
