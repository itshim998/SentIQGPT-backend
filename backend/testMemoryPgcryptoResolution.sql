\set ON_ERROR_STOP on

-- Reproduce the Supabase layout where pgcrypto is installed in `extensions`,
-- while application functions intentionally search only `public, pg_temp`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if to_regprocedure('extensions.digest(text,text)') is null then
    raise exception 'pgcrypto digest was not installed in extensions';
  end if;
  if to_regprocedure('public.digest(text,text)') is not null then
    raise exception 'test precondition failed: public digest already exists';
  end if;
end;
$$;

\i supabase/migrations/20260805145950_prepare_memory_pgcrypto_resolution.sql

create or replace function public.phase3_pgcrypto_resolution_probe(p_value text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  return encode(digest(p_value, 'sha256'), 'hex');
end;
$$;

do $$
declare
  v_expected text;
  v_actual text;
begin
  v_expected := encode(
    extensions.digest('memory subject fallback', 'sha256'),
    'hex'
  );
  v_actual := public.phase3_pgcrypto_resolution_probe('memory subject fallback');

  if v_actual <> v_expected or length(v_actual) <> 64 then
    raise exception 'pgcrypto compatibility mismatch: expected=% actual=%',
      v_expected,
      v_actual;
  end if;

  if public.get_memory_pgcrypto_resolution_schema_version() <> '20260805145950' then
    raise exception 'pgcrypto resolution schema marker mismatch';
  end if;
end;
$$;

-- The hotfix must be idempotent for SQL-editor retries.
\i supabase/migrations/20260805145950_prepare_memory_pgcrypto_resolution.sql

select 'phase3-memory-pgcrypto-resolution-ok' as result;
