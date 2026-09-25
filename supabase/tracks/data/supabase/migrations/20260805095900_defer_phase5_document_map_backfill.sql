-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Defers the initial Phase 5 document-map backfill until the hardened builder is
-- installed. This prevents one malformed legacy metadata value from aborting
-- the main FTS migration. New ready-state ingestion is unaffected.

update public.source_documents document
set metadata = coalesce(document.metadata, '{}'::jsonb)
  || jsonb_build_object(
    'document_map_version', 1,
    'document_map_status', 'deferred_phase5_backfill'
  )
where document.status = 'ready'
  and jsonb_typeof(coalesce(document.metadata -> 'document_map', 'null'::jsonb)) is distinct from 'object';
