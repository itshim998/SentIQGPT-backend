-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Phase 4 support indexes for idempotent long-document ingestion and
-- page-aware retrieval. No table rewrite or status-enum change is required.

create index if not exists source_documents_owner_hash_status_updated_idx
  on public.source_documents(owner_user_id, content_hash, status, updated_at desc);

create index if not exists source_chunks_document_page_role_idx
  on public.source_chunks(document_id, page_number, chunk_role, chunk_index)
  where page_number is not null;

comment on index public.source_documents_owner_hash_status_updated_idx is
  'Supports owner-scoped content-hash reuse and interrupted-ingestion recovery.';

comment on index public.source_chunks_document_page_role_idx is
  'Supports page-aware source maps and page-bounded retrieval.';
