-- Unified text-token V2 full-rollout gate.
--
-- RUN ON: Control database (Database 1).
-- APPLY AFTER:
--   20260727120000_unified_text_tokens_v2.sql
--   20260727180000_unified_text_tokens_v2_integrity.sql
--   20260727183000_unified_text_tokens_v2_schema_compat.sql
--
-- This migration is additive. The original base-version RPC remains unchanged
-- for the existing server startup compatibility check. A separate latest
-- full-rollout marker and structural verification RPC gate production rollout.

create or replace function public.get_unified_text_tokens_v2_schema_version()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select '20260727120000'::text;
$$;

create or replace function public.get_unified_text_tokens_v2_full_rollout_schema_version()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select '20260728100000'::text;
$$;

create or replace function public.verify_unified_text_tokens_v2_rollout()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_missing text[] := array[]::text[];
  v_required_functions constant text[] := array[
    'unified_text_tokens_v2_snapshot',
    'reserve_unified_text_tokens_v2',
    'commit_unified_text_tokens_v2',
    'release_unified_text_tokens_v2',
    'get_unified_text_usage_summary_v2',
    'sync_unified_text_v2_rollback_shadows'
  ];
  v_function text;
begin
  if to_regclass('public.unified_text_reservations_v2') is null then
    v_missing := array_append(v_missing, 'table:unified_text_reservations_v2');
  end if;
  if to_regclass('public.unified_text_usage_events_v2') is null then
    v_missing := array_append(v_missing, 'table:unified_text_usage_events_v2');
  end if;

  foreach v_function in array v_required_functions loop
    if not exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_function
    ) then
      v_missing := array_append(v_missing, 'function:' || v_function);
    end if;
  end loop;

  if to_regclass('public.usage_events') is null then
    v_missing := array_append(v_missing, 'table:usage_events');
  end if;
  if to_regclass('public.quota_reservations') is null then
    v_missing := array_append(v_missing, 'table:quota_reservations');
  end if;
  if to_regclass('public.billing_plans') is null then
    v_missing := array_append(v_missing, 'table:billing_plans');
  end if;

  return jsonb_build_object(
    'ready', cardinality(v_missing) = 0,
    'schema_version', '20260728100000',
    'base_schema_version', '20260727120000',
    'missing_count', cardinality(v_missing),
    'missing', to_jsonb(v_missing)
  );
end;
$$;

revoke all on function public.get_unified_text_tokens_v2_schema_version() from public, anon, authenticated;
revoke all on function public.get_unified_text_tokens_v2_full_rollout_schema_version() from public, anon, authenticated;
revoke all on function public.verify_unified_text_tokens_v2_rollout() from public, anon, authenticated;
grant execute on function public.get_unified_text_tokens_v2_schema_version() to service_role;
grant execute on function public.get_unified_text_tokens_v2_full_rollout_schema_version() to service_role;
grant execute on function public.verify_unified_text_tokens_v2_rollout() to service_role;

comment on function public.get_unified_text_tokens_v2_full_rollout_schema_version() is
  'Latest migration marker for the SentIQ unified text-token V2 full rollout.';
comment on function public.verify_unified_text_tokens_v2_rollout() is
  'Service-role-only structural gate for the SentIQ unified text-token V2 full rollout.';
