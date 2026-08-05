\set ON_ERROR_STOP on

-- READ-ONLY verification for Database 2, 3, and 4. Never run on the control
-- database. This checks the installed Phase 6 storage, indexes, RPCs, Fast
-- compatibility adapter, and deterministic capsule metadata without modifying
-- application data.

do $$
declare
  v_missing text[] := array[]::text[];
  v_phase6_version text;
  v_fast_version text;
  v_external_definition text;
  v_internal_definition text;
  v_probe_title text := 'SentIQ latency work';
  v_probe_content text := 'The next step is speculative provider generation while preserving answer quality.';
  v_project_key text;
  v_entity_keys text[];
begin
  if to_regclass('public.context_capsules') is null then
    v_missing := array_append(v_missing, 'table:context_capsules');
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'context_capsules'
      and column_name = 'project_key'
  ) then
    v_missing := array_append(v_missing, 'column:context_capsules.project_key');
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'context_capsules'
      and column_name = 'entity_keys'
      and udt_name = '_text'
  ) then
    v_missing := array_append(v_missing, 'column:context_capsules.entity_keys');
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'context_capsules'
      and column_name = 'continuity_search_vector'
      and is_generated = 'ALWAYS'
  ) then
    v_missing := array_append(v_missing, 'column:context_capsules.continuity_search_vector:generated');
  end if;

  if to_regclass('public.context_capsules_continuity_search_gin_idx') is null then
    v_missing := array_append(v_missing, 'index:context_capsules_continuity_search_gin_idx');
  end if;
  if to_regclass('public.conversations_title_continuity_fts_idx') is null then
    v_missing := array_append(v_missing, 'index:conversations_title_continuity_fts_idx');
  end if;
  if to_regclass('public.messages_continuity_fts_idx') is null then
    v_missing := array_append(v_missing, 'index:messages_continuity_fts_idx');
  end if;
  if to_regclass('public.context_capsules_owner_project_idx') is null then
    v_missing := array_append(v_missing, 'index:context_capsules_owner_project_idx');
  end if;

  if to_regprocedure('public.normalize_continuity_key(text)') is null then
    v_missing := array_append(v_missing, 'function:normalize_continuity_key');
  end if;
  if to_regprocedure('public.infer_context_capsule_project_key(text,text)') is null then
    v_missing := array_append(v_missing, 'function:infer_context_capsule_project_key');
  end if;
  if to_regprocedure('public.extract_context_capsule_entity_keys(text,text,text)') is null then
    v_missing := array_append(v_missing, 'function:extract_context_capsule_entity_keys');
  end if;
  if to_regprocedure('public.prepare_context_capsule_continuity_row()') is null then
    v_missing := array_append(v_missing, 'function:prepare_context_capsule_continuity_row');
  end if;
  if to_regprocedure('public.search_cross_conversation_context(uuid,text,uuid,integer,integer,integer)') is null then
    v_missing := array_append(v_missing, 'function:search_cross_conversation_context');
  end if;
  if to_regprocedure('public.get_fast_context_snapshot_phase6_internal(uuid,uuid,text,text,uuid[],integer,integer,integer)') is null then
    v_missing := array_append(v_missing, 'function:get_fast_context_snapshot_phase6_internal');
  end if;
  if to_regprocedure('public.get_fast_context_snapshot(uuid,uuid,text,text,uuid[],integer,integer,integer)') is null then
    v_missing := array_append(v_missing, 'function:get_fast_context_snapshot');
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.context_capsules'::regclass
      and tgname = 'prepare_context_capsule_continuity_row_trigger'
      and not tgisinternal
  ) then
    v_missing := array_append(v_missing, 'trigger:prepare_context_capsule_continuity_row_trigger');
  end if;

  begin
    v_project_key := public.infer_context_capsule_project_key(v_probe_title, v_probe_content);
    v_entity_keys := public.extract_context_capsule_entity_keys(
      v_probe_title,
      v_probe_content,
      v_project_key
    );

    if v_project_key is null or position('sentiq' in v_project_key) = 0 then
      v_missing := array_append(v_missing, 'function:project_key_probe');
    end if;
    if not ('sentiq' = any(coalesce(v_entity_keys, array[]::text[])))
       or not ('latency' = any(coalesce(v_entity_keys, array[]::text[]))) then
      v_missing := array_append(v_missing, 'function:entity_key_probe');
    end if;
  exception when others then
    v_missing := array_append(v_missing, 'function:continuity_metadata_probe_failed');
  end;

  if exists (
    select 1
    from public.context_capsules as capsule
    where capsule.scope = 'conversation'
      and (
        capsule.entity_keys is null
        or capsule.continuity_search_vector is null
      )
  ) then
    v_missing := array_append(v_missing, 'data:invalid_conversation_capsule_continuity_metadata');
  end if;

  select pg_get_functiondef(
    'public.get_fast_context_snapshot(uuid,uuid,text,text,uuid[],integer,integer,integer)'::regprocedure
  ) into v_external_definition;
  select pg_get_functiondef(
    'public.get_fast_context_snapshot_phase6_internal(uuid,uuid,text,text,uuid[],integer,integer,integer)'::regprocedure
  ) into v_internal_definition;

  if position('get_fast_context_snapshot_phase6_internal' in coalesce(v_external_definition, '')) = 0
     or position('schema_version' in coalesce(v_external_definition, '')) = 0
     or position('SELECTED CROSS-CONVERSATION CONTINUITY' in coalesce(v_external_definition, '')) = 0 then
    v_missing := array_append(v_missing, 'function:fast_snapshot_compatibility_adapter');
  end if;

  if position('search_cross_conversation_context' in coalesce(v_internal_definition, '')) = 0
     or position('continuity' in coalesce(v_internal_definition, '')) = 0 then
    v_missing := array_append(v_missing, 'function:fast_snapshot_internal_continuity');
  end if;

  if to_regprocedure('public.get_cross_conversation_continuity_schema_version()') is not null then
    v_phase6_version := public.get_cross_conversation_continuity_schema_version();
  end if;
  if to_regprocedure('public.get_fast_context_snapshot_schema_version()') is not null then
    v_fast_version := public.get_fast_context_snapshot_schema_version();
  end if;

  if v_phase6_version is distinct from '20260805220000' then
    v_missing := array_append(v_missing, 'version:cross_conversation_continuity');
  end if;
  if v_fast_version is distinct from '20260805220100' then
    v_missing := array_append(v_missing, 'version:fast_context_snapshot_phase6');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception 'Phase 6 migration verification failed: %', array_to_string(v_missing, ', ');
  end if;

  raise notice 'Phase 6 migration verification passed. continuity=%, fast=%',
    v_phase6_version, v_fast_version;
end;
$$;

select jsonb_build_object(
  'ready', true,
  'continuity_schema_version', public.get_cross_conversation_continuity_schema_version(),
  'fast_snapshot_schema_version', public.get_fast_context_snapshot_schema_version(),
  'conversation_capsules', count(*) filter (where scope = 'conversation'),
  'project_keyed_capsules', count(*) filter (
    where scope = 'conversation' and project_key is not null
  ),
  'capsule_metadata_valid', coalesce(bool_and(
    case
      when scope = 'conversation' then entity_keys is not null and continuity_search_vector is not null
      else true
    end
  ), true)
) as phase6_verification
from public.context_capsules;
