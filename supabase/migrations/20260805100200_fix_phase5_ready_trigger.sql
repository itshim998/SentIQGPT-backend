-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- The Phase 5 map builder updates source_documents.metadata. Running that
-- update from an AFTER ROW trigger on the same source_documents statement can
-- be rejected by PostgreSQL as a self-modifying trigger operation. Replace the
-- row trigger with an AFTER STATEMENT trigger using transition tables so the
-- original status update has completed before map metadata is persisted.

create or replace function public.refresh_source_document_maps_after_statement()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_document record;
begin
  for v_document in
    select new_row.id, new_row.owner_user_id
    from phase5_new_source_documents new_row
    join phase5_old_source_documents old_row
      on old_row.id = new_row.id
    where new_row.status = 'ready'
      and (
        old_row.status is distinct from new_row.status
        or coalesce(new_row.metadata ->> 'document_map_status', '') <> 'ready'
        or jsonb_typeof(coalesce(new_row.metadata -> 'document_map', 'null'::jsonb)) is distinct from 'object'
      )
  loop
    begin
      perform public.refresh_source_document_map(
        v_document.id,
        v_document.owner_user_id
      );
    exception when others then
      update public.source_documents document
      set metadata = coalesce(document.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'document_map_status', 'failed',
          'document_map_failure_type', sqlstate
        )
      where document.id = v_document.id
        and document.owner_user_id = v_document.owner_user_id;
    end;
  end loop;

  return null;
end;
$$;

drop trigger if exists source_documents_refresh_map_on_ready
  on public.source_documents;

create trigger source_documents_refresh_map_on_ready
after update on public.source_documents
referencing
  old table as phase5_old_source_documents
  new table as phase5_new_source_documents
for each statement
execute function public.refresh_source_document_maps_after_statement();

revoke all on function public.refresh_source_document_maps_after_statement()
  from public, anon;

comment on function public.refresh_source_document_maps_after_statement() is
  'Builds Phase 5 maps after ready-state update statements complete, avoiding same-row trigger modification.';
