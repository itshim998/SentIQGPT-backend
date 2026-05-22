-- SentIQGPT Atomic Image Generation Quota RPC
--
-- RUN ON: Database 1, 2, 3, 4 (Control DB + Data shards)
--
-- Image generation reserves quota before the provider call and releases it
-- only when the provider fails before producing an accepted result.

create or replace function public.reserve_daily_image_generation(
    p_user_id uuid,
    p_daily_limit integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    updated_count integer;
begin
    perform public.ensure_user_exists(p_user_id);
    perform public.ensure_daily_usage_row(p_user_id);

    update public.usage_logs
    set images_generated = images_generated + 1
    where user_id = p_user_id
      and date = current_date
      and images_generated < p_daily_limit
    returning images_generated into updated_count;

    return updated_count is not null;
end;
$$;

create or replace function public.release_daily_image_generation(
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.usage_logs
    set images_generated = greatest(images_generated - 1, 0)
    where user_id = p_user_id
      and date = current_date
      and images_generated > 0;
end;
$$;

revoke all on function public.reserve_daily_image_generation(uuid, integer) from public;
revoke all on function public.reserve_daily_image_generation(uuid, integer) from anon;
revoke all on function public.reserve_daily_image_generation(uuid, integer) from authenticated;
grant execute on function public.reserve_daily_image_generation(uuid, integer) to service_role;

revoke all on function public.release_daily_image_generation(uuid) from public;
revoke all on function public.release_daily_image_generation(uuid) from anon;
revoke all on function public.release_daily_image_generation(uuid) from authenticated;
grant execute on function public.release_daily_image_generation(uuid) to service_role;
