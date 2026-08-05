-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
-- APPLY BEFORE:
--   20260805150000_improve_memory_hybrid_retrieval.sql
--
-- Supabase installs pgcrypto in the trusted `extensions` schema. The original
-- Phase 3 subject-key function intentionally restricted its search_path to
-- `public, pg_temp`, so its unqualified digest(text, text) call could not be
-- resolved on shards where pgcrypto is not installed in public.
--
-- Keep the existing SHA-256 subject-key format by exposing a tightly scoped,
-- idempotent public compatibility wrapper only when pgcrypto lives outside
-- public. This lets the already-published Phase 3 migrations run unchanged and
-- avoids moving or reinstalling the extension.

do $$
declare
  v_pgcrypto_schema text;
begin
  select namespace.nspname
  into v_pgcrypto_schema
  from pg_extension as extension
  join pg_namespace as namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  if v_pgcrypto_schema is null then
    raise exception 'pgcrypto extension is not installed';
  end if;

  if v_pgcrypto_schema <> 'public' then
    if to_regprocedure('public.digest(text,text)') is null then
      execute format(
        $ddl$
          create function public.digest(p_data text, p_type text)
          returns bytea
          language sql
          immutable
          strict
          security definer
          set search_path = pg_catalog, %1$I, pg_temp
          as $function$
            select %1$I.digest(p_data, p_type)
          $function$
        $ddl$,
        v_pgcrypto_schema
      );
    end if;

    revoke all on function public.digest(text, text) from public, anon;
    grant execute on function public.digest(text, text)
      to authenticated, service_role;
  end if;
end;
$$;

do $$
declare
  v_probe text;
begin
  v_probe := encode(public.digest('sentiq-memory-pgcrypto-probe', 'sha256'), 'hex');
  if length(v_probe) <> 64 then
    raise exception 'public.digest SHA-256 compatibility probe failed';
  end if;
end;
$$;

comment on function public.digest(text, text) is
  'SentIQ compatibility wrapper for pgcrypto digest when Supabase installs pgcrypto outside public.';

create or replace function public.get_memory_pgcrypto_resolution_schema_version()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select '20260805145950'::text;
$$;

revoke all on function public.get_memory_pgcrypto_resolution_schema_version()
  from public, anon, authenticated;
grant execute on function public.get_memory_pgcrypto_resolution_schema_version()
  to service_role;
