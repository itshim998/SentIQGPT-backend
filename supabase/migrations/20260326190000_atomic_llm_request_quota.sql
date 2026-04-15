-- ═══════════════════════════════════════════════════════════════════════════════
-- SentIQGPT Atomic LLM Request Quota RPC
--
-- RUN ON: Database 1, 2, 3, 4 (Control DB + Data shards)
--
-- Notes:
-- 1) This function is called by backend/llm_service.py with service_role.
-- 2) Depends on ensure_user_exists + ensure_daily_usage_row definitions.
-- 3) Apply 20260326213000_fix_multi_db_session_bootstrap.sql first if absent.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.reserve_daily_llm_request(
    p_user_id uuid,
    p_daily_limit integer default 50
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
    set requests_count = requests_count + 1
    where user_id = p_user_id
      and date = current_date
      and requests_count < p_daily_limit
    returning requests_count into updated_count;

    return updated_count is not null;
end;
$$;

revoke all on function public.reserve_daily_llm_request(uuid, integer) from public;
revoke all on function public.reserve_daily_llm_request(uuid, integer) from anon;
revoke all on function public.reserve_daily_llm_request(uuid, integer) from authenticated;
grant execute on function public.reserve_daily_llm_request(uuid, integer) to service_role;
