-- Unified text-token V2 pgcrypto resolution and full-rollout readiness repair.
--
-- RUN ON: Control database (Database 1).
-- APPLY AFTER:
--   20260728100000_unified_text_tokens_v2_full_rollout_gate.sql
--
-- This migration is additive. Supabase installs pgcrypto in the trusted
-- `extensions` schema, while the rollback-shadow function previously searched
-- only `public, pg_temp`. That made every V2 commit roll back when digest()
-- could not be resolved.

alter function public.sync_unified_text_v2_rollback_shadows(uuid)
  set search_path = public, extensions, pg_temp;

create or replace function public.get_unified_text_tokens_v2_full_rollout_schema_version()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select '20260728180000'::text;
$$;

create or replace function public.verify_unified_text_tokens_v2_rollout()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
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
  v_digest_probe text;
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

  begin
    v_digest_probe := encode(digest('sentiq-unified-text-readiness', 'sha256'), 'hex');
    if length(v_digest_probe) <> 64 then
      v_missing := array_append(v_missing, 'function:pgcrypto_digest');
    end if;
  exception
    when others then
      v_missing := array_append(v_missing, 'function:pgcrypto_digest');
  end;

  if not exists (
    select 1
    from pg_proc p
    where p.oid = to_regprocedure('public.sync_unified_text_v2_rollback_shadows(uuid)')
      and array_to_string(coalesce(p.proconfig, array[]::text[]), ',')
        like '%search_path=public, extensions, pg_temp%'
  ) then
    v_missing := array_append(v_missing, 'function:sync_unified_text_v2_rollback_shadows:extensions_search_path');
  end if;

  return jsonb_build_object(
    'ready', cardinality(v_missing) = 0,
    'schema_version', '20260728180000',
    'base_schema_version', '20260727120000',
    'missing_count', cardinality(v_missing),
    'missing', to_jsonb(v_missing)
  );
end;
$$;

revoke all on function public.get_unified_text_tokens_v2_full_rollout_schema_version() from public, anon, authenticated;
revoke all on function public.verify_unified_text_tokens_v2_rollout() from public, anon, authenticated;
grant execute on function public.get_unified_text_tokens_v2_full_rollout_schema_version() to service_role;
grant execute on function public.verify_unified_text_tokens_v2_rollout() to service_role;

comment on function public.get_unified_text_tokens_v2_full_rollout_schema_version() is
  'Latest migration marker for the SentIQ unified text-token V2 full rollout.';
comment on function public.verify_unified_text_tokens_v2_rollout() is
  'Service-role-only functional gate for the SentIQ unified text-token V2 full rollout.';
