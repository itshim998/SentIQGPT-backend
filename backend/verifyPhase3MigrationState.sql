\set ON_ERROR_STOP on

-- READ-ONLY verification for Database 2, 3, and 4. Never run on the control
-- database. This checks installed objects and functional behavior without
-- inserting, updating, or deleting application rows.

do $$
declare
  v_missing text[] := array[]::text[];
  v_digest_probe text;
  v_preference_key text;
  v_fallback_key text;
  v_pgcrypto_version text := 'functional-no-marker';
  v_memory_version text;
  v_fast_version text;
begin
  if to_regclass('public.memories') is null then
    v_missing := array_append(v_missing, 'table:memories');
  end if;

  if to_regclass('public.memories_search_vector_gin_idx') is null then
    v_missing := array_append(v_missing, 'index:memories_search_vector_gin_idx');
  end if;
  if to_regclass('public.memories_active_subject_idx') is null then
    v_missing := array_append(v_missing, 'index:memories_active_subject_idx');
  end if;
  if to_regclass('public.memories_active_anchor_idx') is null then
    v_missing := array_append(v_missing, 'index:memories_active_anchor_idx');
  end if;

  if to_regprocedure('public.digest(text,text)') is null then
    v_missing := array_append(v_missing, 'function:public.digest(text,text)');
  else
    begin
      v_digest_probe := encode(public.digest('sentiq-phase3-readiness', 'sha256'), 'hex');
      if length(v_digest_probe) <> 64 then
        v_missing := array_append(v_missing, 'function:public.digest:invalid_sha256');
      end if;
    exception when others then
      v_missing := array_append(v_missing, 'function:public.digest:execution_failed');
    end;
  end if;

  if to_regprocedure('public.normalize_memory_subject_key(text,text,text)') is null then
    v_missing := array_append(v_missing, 'function:normalize_memory_subject_key');
  else
    begin
      v_preference_key := public.normalize_memory_subject_key(
        'preference',
        'The user prefers concise answers.',
        null
      );
      v_fallback_key := public.normalize_memory_subject_key(
        'project',
        'A durable unnamed project fact.',
        null
      );
      if v_preference_key <> 'preference:response_length' then
        v_missing := array_append(v_missing, 'function:normalize_memory_subject_key:preference_probe');
      end if;
      if v_fallback_key !~ '^project:[0-9a-f]{32}$' then
        v_missing := array_append(v_missing, 'function:normalize_memory_subject_key:digest_probe');
      end if;
    exception when others then
      v_missing := array_append(v_missing, 'function:normalize_memory_subject_key:execution_failed');
    end;
  end if;

  if to_regprocedure('public.search_memories_lexical(uuid,text,uuid,integer)') is null then
    v_missing := array_append(v_missing, 'function:search_memories_lexical');
  end if;
  if to_regprocedure('public.persist_memory_with_lifecycle(uuid,text,text,integer,jsonb,text,timestamptz,text,uuid,uuid,uuid,text,text,real,text,text,text)') is null then
    v_missing := array_append(v_missing, 'function:persist_memory_with_lifecycle');
  end if;
  if to_regprocedure('public.infer_memory_project_scope(text)') is null then
    v_missing := array_append(v_missing, 'function:infer_memory_project_scope');
  end if;
  if to_regprocedure('public.prepare_memory_lifecycle_row()') is null then
    v_missing := array_append(v_missing, 'function:prepare_memory_lifecycle_row');
  end if;
  if to_regprocedure('public.get_fast_context_snapshot(uuid,uuid,text,text,uuid[],integer,integer,integer)') is null then
    v_missing := array_append(v_missing, 'function:get_fast_context_snapshot');
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'memories'
      and column_name = 'search_vector'
      and is_generated = 'ALWAYS'
  ) then
    v_missing := array_append(v_missing, 'column:memories.search_vector:generated');
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.memories'::regclass
      and tgname = 'prepare_memory_lifecycle_row_trigger'
      and not tgisinternal
  ) then
    v_missing := array_append(v_missing, 'trigger:prepare_memory_lifecycle_row_trigger');
  end if;

  if exists (
    select 1
    from public.memories
    where subject_key is null
       or last_confirmed_at is null
       or fact_type is null
       or status not in ('active', 'superseded')
       or confidence < 0
       or confidence > 1
  ) then
    v_missing := array_append(v_missing, 'data:invalid_memory_lifecycle_metadata');
  end if;

  if to_regprocedure('public.get_memory_pgcrypto_resolution_schema_version()') is not null then
    v_pgcrypto_version := public.get_memory_pgcrypto_resolution_schema_version();
    if v_pgcrypto_version is distinct from '20260805145950' then
      v_missing := array_append(v_missing, 'version:memory_pgcrypto_resolution');
    end if;
  end if;
  if to_regprocedure('public.get_memory_hybrid_retrieval_schema_version()') is not null then
    v_memory_version := public.get_memory_hybrid_retrieval_schema_version();
  end if;
  if to_regprocedure('public.get_fast_context_snapshot_schema_version()') is not null then
    v_fast_version := public.get_fast_context_snapshot_schema_version();
  end if;

  if v_memory_version is distinct from '20260805150000' then
    v_missing := array_append(v_missing, 'version:memory_hybrid_retrieval');
  end if;
  if v_fast_version is distinct from '20260805150100'
     and v_fast_version is distinct from '20260805220100' then
    v_missing := array_append(v_missing, 'version:fast_context_snapshot');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception 'Phase 3 migration verification failed: %', array_to_string(v_missing, ', ');
  end if;

  raise notice 'Phase 3 migration verification passed. pgcrypto=%, memory=%, fast=%',
    v_pgcrypto_version, v_memory_version, v_fast_version;
end;
$$;

select jsonb_build_object(
  'ready', true,
  'pgcrypto_marker_installed',
    to_regprocedure('public.get_memory_pgcrypto_resolution_schema_version()') is not null,
  'pgcrypto_digest_functional',
    length(encode(public.digest('sentiq-phase3-readiness', 'sha256'), 'hex')) = 64,
  'memory_schema_version', public.get_memory_hybrid_retrieval_schema_version(),
  'fast_snapshot_schema_version', public.get_fast_context_snapshot_schema_version(),
  'active_memories', count(*) filter (where status = 'active'),
  'superseded_memories', count(*) filter (where status = 'superseded'),
  'lifecycle_rows_valid', coalesce(bool_and(
    subject_key is not null
    and last_confirmed_at is not null
    and fact_type is not null
    and status in ('active', 'superseded')
    and confidence between 0 and 1
  ), true)
) as phase3_verification
from public.memories;
