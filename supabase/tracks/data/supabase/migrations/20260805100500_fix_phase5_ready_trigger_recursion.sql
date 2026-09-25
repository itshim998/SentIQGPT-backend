-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- A document-map failure is recorded by updating source_documents.metadata.
-- The previous AFTER STATEMENT trigger treated any ready row whose map was not
-- ready as fresh work, so that failure update recursively invoked the builder
-- and its failure handler. Restrict automatic map generation to the actual
-- status transition into ready. Explicit migration backfills remain responsible
-- for retrying legacy or previously failed ready documents.

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

revoke all on function public.refresh_source_document_maps_after_statement()
  from public, anon;

grant execute on function public.refresh_source_document_maps_after_statement()
  to authenticated, service_role;

comment on function public.refresh_source_document_maps_after_statement() is
  'Builds maps only when a document transitions into ready, preventing recursive failure-metadata updates while preserving bounded diagnostics.';
