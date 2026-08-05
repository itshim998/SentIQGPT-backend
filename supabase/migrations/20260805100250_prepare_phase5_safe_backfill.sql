-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Production rollout hotfix. Install this after
-- 20260805100200_fix_phase5_ready_trigger.sql and before
-- 20260805100300_fix_phase5_map_ambiguity.sql.
--
-- The earlier AFTER STATEMENT trigger reacted to metadata-only updates when a
-- ready document did not yet have a map. If map generation failed, its failure
-- metadata update re-entered the trigger recursively until PostgreSQL exhausted
-- the stack. The map backfill also needs PostgreSQL-compatible sentence regexes
-- before it retries existing ready documents.

create or replace function public.source_first_sentence(p_text text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := regexp_replace(
    btrim(coalesce(p_text, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  v_match text[];
begin
  if v_text = '' then
    return '';
  end if;

  v_match := regexp_match(v_text, '^([^.!?]*[.!?])');
  return left(coalesce(v_match[1], v_text), 500);
end;
$$;

create or replace function public.source_last_sentence(p_text text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := regexp_replace(
    btrim(coalesce(p_text, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  v_match text[];
  v_last text := '';
begin
  if v_text = '' then
    return '';
  end if;

  for v_match in
    select matched.parts
    from regexp_matches(
      v_text,
      '([^.!?]+[.!?]|[^.!?]+$)',
      'g'
    ) as matched(parts)
  loop
    if btrim(coalesce(v_match[1], '')) <> '' then
      v_last := btrim(v_match[1]);
    end if;
  end loop;

  return right(case when v_last <> '' then v_last else v_text end, 500);
end;
$$;

create or replace function public.refresh_source_document_maps_after_statement()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_document record;
  v_failure_sqlstate text;
  v_failure_message text;
  v_failure_detail text;
  v_failure_hint text;
  v_failure_context text;
begin
  for v_document in
    select
      new_row.id as document_id,
      new_row.owner_user_id as owner_user_id
    from phase5_new_source_documents as new_row
    join phase5_old_source_documents as old_row
      on old_row.id = new_row.id
    where new_row.status = 'ready'
      and old_row.status is distinct from new_row.status
  loop
    begin
      perform public.refresh_source_document_map(
        v_document.document_id,
        v_document.owner_user_id
      );
    exception when others then
      get stacked diagnostics
        v_failure_sqlstate = returned_sqlstate,
        v_failure_message = message_text,
        v_failure_detail = pg_exception_detail,
        v_failure_hint = pg_exception_hint,
        v_failure_context = pg_exception_context;

      update public.source_documents as source_document
      set metadata = coalesce(source_document.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'document_map_status', 'failed',
          'document_map_failure_type', coalesce(v_failure_sqlstate, ''),
          'document_map_failure_message',
            left(coalesce(v_failure_message, ''), 1000),
          'document_map_failure_detail',
            left(coalesce(v_failure_detail, ''), 1000),
          'document_map_failure_hint',
            left(coalesce(v_failure_hint, ''), 1000),
          'document_map_failure_context',
            left(coalesce(v_failure_context, ''), 4000)
        )
      where source_document.id = v_document.document_id
        and source_document.owner_user_id = v_document.owner_user_id;
    end;
  end loop;

  return null;
end;
$$;

revoke all on function public.source_first_sentence(text) from public, anon;
revoke all on function public.source_last_sentence(text) from public, anon;
revoke all on function public.refresh_source_document_maps_after_statement()
  from public, anon;

grant execute on function public.source_first_sentence(text)
  to authenticated, service_role;
grant execute on function public.source_last_sentence(text)
  to authenticated, service_role;
grant execute on function public.refresh_source_document_maps_after_statement()
  to authenticated, service_role;

comment on function public.refresh_source_document_maps_after_statement() is
  'Builds maps only on the status transition into ready, preventing recursive metadata-only trigger updates during Phase 5 backfill.';
