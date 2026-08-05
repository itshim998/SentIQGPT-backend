\set ON_ERROR_STOP on

create extension if not exists pgcrypto;

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

create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists public.users (
  id uuid primary key
);

create table if not exists public.conversations (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  unique(id, user_id)
);

\i supabase/migrations/20260702160000_add_source_document_retrieval.sql
\i supabase/migrations/20260805043000_harden_long_pdf_ingestion.sql

insert into public.users(id)
values ('00000000-0000-4000-8000-000000000601')
on conflict do nothing;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000601',
  false
);

-- This ready document exists before Phase 5, matching the production rollout
-- state that previously caused SQL 5 to recurse through metadata updates.
insert into public.source_documents(
  id, owner_user_id, conversation_id, title, original_filename, mime_type,
  source_type, content_hash, status, metadata
)
values (
  '00000000-0000-4000-8000-000000000611',
  '00000000-0000-4000-8000-000000000601',
  null,
  'Existing Ready Policy',
  'existing-ready-policy.pdf',
  'application/pdf',
  'pdf',
  repeat('c', 64),
  'ready',
  jsonb_build_object('page_count', 2)
);

insert into public.source_chunks(
  id, document_id, owner_user_id, conversation_id, parent_chunk_id,
  chunk_role, chunk_index, heading, path, page_number, content,
  context_prefix, token_estimate, metadata
)
values
(
  '00000000-0000-4000-8000-000000000621',
  '00000000-0000-4000-8000-000000000611',
  '00000000-0000-4000-8000-000000000601', null, null,
  'parent', 0, 'Existing Section', 'Policy > Existing Section', 1,
  'The existing policy begins here. It establishes a ten percent target. The section ends with implementation guidance.',
  'Existing Ready Policy > Existing Section', 40, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000622',
  '00000000-0000-4000-8000-000000000611',
  '00000000-0000-4000-8000-000000000601', null,
  '00000000-0000-4000-8000-000000000621',
  'child', 0, 'Existing Section', 'Policy > Existing Section', 1,
  'The binding target is 10 percent by 2030.',
  'Existing Ready Policy > Existing Section', 16, '{}'::jsonb
);

\i supabase/migrations/20260805095900_defer_phase5_document_map_backfill.sql
\i supabase/migrations/20260805100000_strengthen_source_fts_retrieval.sql
\i supabase/migrations/20260805100100_harden_phase5_document_maps.sql
\i supabase/migrations/20260805100200_fix_phase5_ready_trigger.sql
\i supabase/migrations/20260805100250_prepare_phase5_safe_backfill.sql
\i supabase/migrations/20260805100300_fix_phase5_map_ambiguity.sql
\i supabase/migrations/20260805100400_fix_phase5_search_rpc_ambiguity.sql
\i supabase/migrations/20260805100500_fix_phase5_ready_trigger_recursion.sql
\i supabase/migrations/20260805100600_fix_phase5_sentence_regex.sql

do $$
declare
  v_metadata jsonb;
begin
  select source_document.metadata
  into v_metadata
  from public.source_documents as source_document
  where source_document.id = '00000000-0000-4000-8000-000000000611';

  if coalesce(v_metadata ->> 'document_map_status', '') <> 'ready' then
    raise exception 'existing ready document map was not backfilled: %', v_metadata;
  end if;

  if jsonb_typeof(v_metadata -> 'document_map') is distinct from 'object' then
    raise exception 'existing ready document map is missing: %', v_metadata;
  end if;
end;
$$;

-- A metadata-only update must not re-enter map generation or recurse.
update public.source_documents as source_document
set metadata = source_document.metadata || jsonb_build_object('phase5_probe', true)
where source_document.id = '00000000-0000-4000-8000-000000000611';

do $$
declare
  v_probe boolean;
begin
  select coalesce((source_document.metadata ->> 'phase5_probe')::boolean, false)
  into v_probe
  from public.source_documents as source_document
  where source_document.id = '00000000-0000-4000-8000-000000000611';

  if not v_probe then
    raise exception 'metadata-only update did not complete';
  end if;
end;
$$;

select 'phase5-existing-ready-backfill-ok' as result;
