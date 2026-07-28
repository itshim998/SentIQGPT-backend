-- Preserve the established startup schema-version contract while the additive
-- Pass 5.1 integrity RPCs are verified by migration and PostgreSQL suites.
-- The control-database startup probe currently expects the original V2 base
-- version and must remain compatible during the reversible rollout.

create or replace function public.get_unified_text_tokens_v2_schema_version()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select '20260727120000'::text;
$$;

revoke all on function public.get_unified_text_tokens_v2_schema_version() from public, anon, authenticated;
grant execute on function public.get_unified_text_tokens_v2_schema_version() to service_role;
