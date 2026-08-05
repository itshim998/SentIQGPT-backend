\set ON_ERROR_STOP on

-- Safe read-only Phase 5 applied-state verifier for Database 2/3/4.
-- It validates installed schema objects and function bodies rather than relying
-- only on migration-history rows, so it also works when migrations were applied
-- manually through the Supabase SQL editor.

do $$
declare
  v_definition text;
  v_generated text;
  v_trigger_definition text;
begin
  if to_regclass('public.source_documents') is null
     or to_regclass('public.source_chunks') is null then
    raise exception 'Phase 5 base source tables are missing';
  end if;

  select pg_get_expr(attribute.attgenerated::text::pg_node_tree, attribute.attrelid)
  into v_generated
  from pg_attribute as attribute
  where attribute.attrelid = 'public.source_chunks'::regclass
    and attribute.attname = 'fts_weighted'
    and not attribute.attisdropped;

  if v_generated is null then
    raise exception 'source_chunks.fts_weighted generated column is missing';
  end if;

  if to_regclass('public.source_chunks_fts_weighted_idx') is null then
    raise exception 'source_chunks_fts_weighted_idx is missing';
  end if;

  if to_regprocedure('public.source_infer_retrieval_mode(text,integer)') is null then
    raise exception 'source_infer_retrieval_mode is missing';
  end if;
  if to_regprocedure('public.source_expand_query_terms(uuid,uuid[],text)') is null then
    raise exception 'source_expand_query_terms is missing';
  end if;
  if to_regprocedure('public.refresh_source_document_map(uuid,uuid)') is null then
    raise exception 'refresh_source_document_map is missing';
  end if;
  if to_regprocedure('public.refresh_source_document_maps_after_statement()') is null then
    raise exception 'refresh_source_document_maps_after_statement is missing';
  end if;
  if to_regprocedure('public.search_source_chunks(uuid,uuid[],text,integer)') is null then
    raise exception 'search_source_chunks is missing';
  end if;
  if to_regprocedure('public.source_first_sentence(text)') is null
     or to_regprocedure('public.source_last_sentence(text)') is null then
    raise exception 'PostgreSQL-safe sentence helpers are missing';
  end if;

  select pg_get_functiondef(
    'public.refresh_source_document_maps_after_statement()'::regprocedure
  ) into v_definition;
  if position('old_row.status is distinct from new_row.status' in lower(v_definition)) = 0 then
    raise exception 'ready trigger function is not transition-only';
  end if;
  if position('left(coalesce(v_failure_context' in lower(v_definition)) = 0 then
    raise exception 'ready trigger diagnostics are not bounded';
  end if;

  select pg_get_functiondef(
    'public.search_source_chunks(uuid,uuid[],text,integer)'::regprocedure
  ) into v_definition;
  if position('#variable_conflict use_column' in lower(v_definition)) = 0 then
    raise exception 'search_source_chunks variable-conflict guard is missing';
  end if;
  if position('selected_counts.document_id = deduped.document_id' in lower(v_definition)) = 0 then
    raise exception 'search_source_chunks qualified join correction is missing';
  end if;

  select pg_get_triggerdef(trigger.oid, true)
  into v_trigger_definition
  from pg_trigger as trigger
  where trigger.tgrelid = 'public.source_documents'::regclass
    and trigger.tgname = 'source_documents_refresh_map_on_ready'
    and not trigger.tgisinternal;

  if v_trigger_definition is null then
    raise exception 'source_documents_refresh_map_on_ready trigger is missing';
  end if;
  if position('referencing old table as phase5_old_source_documents' in lower(v_trigger_definition)) = 0
     or position('new table as phase5_new_source_documents' in lower(v_trigger_definition)) = 0 then
    raise exception 'ready trigger transition tables are missing';
  end if;

  if public.source_first_sentence('First sentence. Second sentence!') <> 'First sentence.' then
    raise exception 'source_first_sentence smoke check failed';
  end if;
  if public.source_last_sentence('First sentence. Second sentence!') <> 'Second sentence!' then
    raise exception 'source_last_sentence smoke check failed';
  end if;

  if public.source_infer_retrieval_mode('Give me a chronological timeline', 1) <> 'timeline' then
    raise exception 'retrieval-mode smoke check failed';
  end if;
end;
$$;

select
  'phase5-migrations-verified' as result,
  current_database() as database_name,
  current_setting('server_version') as postgres_version,
  now() as verified_at;
