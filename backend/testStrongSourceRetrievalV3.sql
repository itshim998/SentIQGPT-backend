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
\i supabase/migrations/20260805095900_defer_phase5_document_map_backfill.sql
\i supabase/migrations/20260805100000_strengthen_source_fts_retrieval.sql
\i supabase/migrations/20260805100100_harden_phase5_document_maps.sql
\i supabase/migrations/20260805100200_fix_phase5_ready_trigger.sql
\i supabase/migrations/20260805100300_fix_phase5_map_ambiguity.sql

insert into public.users(id)
values ('00000000-0000-4000-8000-000000000501')
on conflict do nothing;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000501',
  false
);

insert into public.source_documents(
  id, owner_user_id, conversation_id, title, original_filename, mime_type,
  source_type, content_hash, status, metadata
)
values
(
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501',
  null,
  'Climate Policy 2030',
  'climate-policy-2030.pdf',
  'application/pdf',
  'pdf',
  repeat('a', 64),
  'processing',
  jsonb_build_object('page_count', 'not-a-number', 'declared_page_count', 5)
),
(
  '00000000-0000-4000-8000-000000000512',
  '00000000-0000-4000-8000-000000000501',
  null,
  'Industry Transition Plan',
  'industry-transition.pdf',
  'application/pdf',
  'pdf',
  repeat('b', 64),
  'processing',
  jsonb_build_object('page_count', 3)
);

insert into public.source_chunks(
  id, document_id, owner_user_id, conversation_id, parent_chunk_id,
  chunk_role, chunk_index, heading, path, page_number, content,
  context_prefix, token_estimate, metadata
)
values
(
  '00000000-0000-4000-8000-000000000521',
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501', null, null,
  'parent', 0, 'Emissions Target', 'Climate Policy > Emissions Target', 1,
  'The policy establishes a staged emissions target. The baseline is measured in 2024. The central requirement is a ten percent reduction by 2030.',
  'Climate Policy 2030 > Emissions Target', 60, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000522',
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501', null, null,
  'parent', 1, 'Renewable Investment', 'Climate Policy > Renewable Investment', 3,
  'Renewable investment begins on 2026-04-15. Table 2 lists annual allocations. The programme is administered by the National Energy Council (NEC).',
  'Climate Policy 2030 > Renewable Investment', 60, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000523',
  '00000000-0000-4000-8000-000000000512',
  '00000000-0000-4000-8000-000000000501', null, null,
  'parent', 0, 'Industrial Baseline', 'Industry Plan > Industrial Baseline', 1,
  'The industrial baseline starts on 2025-01-10. The plan targets a 0.10 reduction in covered emissions and reports progress annually.',
  'Industry Transition Plan > Industrial Baseline', 50, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000531',
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501', null,
  '00000000-0000-4000-8000-000000000521',
  'child', 0, 'Emissions Target', 'Climate Policy > Emissions Target', 1,
  'The baseline date is 2024-01-01 and reporting begins immediately.',
  'Climate Policy 2030 > Emissions Target', 20, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000532',
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501', null,
  '00000000-0000-4000-8000-000000000521',
  'child', 1, 'Emissions Target', 'Climate Policy > Emissions Target', 1,
  'The binding target is a 10 percent reduction in covered emissions by 2030.',
  'Climate Policy 2030 > Emissions Target', 22, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000533',
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501', null,
  '00000000-0000-4000-8000-000000000521',
  'child', 2, 'Emissions Target', 'Climate Policy > Emissions Target', 2,
  'Compliance is reviewed after publication of the annual inventory.',
  'Climate Policy 2030 > Emissions Target', 20, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000534',
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501', null,
  '00000000-0000-4000-8000-000000000522',
  'child', 3, 'Renewable Investment', 'Climate Policy > Renewable Investment', 3,
  'Renewable investment begins on 2026-04-15 under the National Energy Council (NEC).',
  'Climate Policy 2030 > Renewable Investment', 25, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000535',
  '00000000-0000-4000-8000-000000000511',
  '00000000-0000-4000-8000-000000000501', null,
  '00000000-0000-4000-8000-000000000522',
  'child', 4, 'Renewable Investment', 'Climate Policy > Renewable Investment', 4,
  'Table 2 allocates funds across solar, wind, storage, and grid upgrades.',
  'Climate Policy 2030 > Renewable Investment', 22, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000536',
  '00000000-0000-4000-8000-000000000512',
  '00000000-0000-4000-8000-000000000501', null,
  '00000000-0000-4000-8000-000000000523',
  'child', 0, 'Industrial Baseline', 'Industry Plan > Industrial Baseline', 1,
  'The industrial transition starts on 2025-01-10.',
  'Industry Transition Plan > Industrial Baseline', 18, '{}'::jsonb
),
(
  '00000000-0000-4000-8000-000000000537',
  '00000000-0000-4000-8000-000000000512',
  '00000000-0000-4000-8000-000000000501', null,
  '00000000-0000-4000-8000-000000000523',
  'child', 1, 'Industrial Baseline', 'Industry Plan > Industrial Baseline', 2,
  'Covered facilities must achieve a 0.10 reduction and disclose annual progress.',
  'Industry Transition Plan > Industrial Baseline', 20, '{}'::jsonb
);

update public.source_documents
set status = 'ready'
where owner_user_id = '00000000-0000-4000-8000-000000000501';

do $$
declare
  v_map jsonb;
  v_metadata jsonb;
begin
  select source_document.metadata -> 'document_map', source_document.metadata
  into v_map, v_metadata
  from public.source_documents as source_document
  where source_document.id = '00000000-0000-4000-8000-000000000511';

  if jsonb_typeof(v_map) is distinct from 'object' then
    raise exception 'document map was not generated; metadata=%', v_metadata;
  end if;
  if coalesce(v_map ->> 'page_count', '') <> '5' then
    raise exception 'guarded page count did not preserve declared page count: %', v_map;
  end if;
  if jsonb_array_length(coalesce(v_map -> 'sections', '[]'::jsonb)) < 2 then
    raise exception 'document map does not span sections: %', v_map;
  end if;
  if coalesce(v_map #>> '{sections,0,first_sentence}', '') = ''
    or coalesce(v_map #>> '{sections,0,last_sentence}', '') = '' then
    raise exception 'section sentence representatives are missing: %', v_map;
  end if;
end;
$$;

create temporary table phase5_percentage_results as
select *
from public.search_source_chunks(
  '00000000-0000-4000-8000-000000000501',
  array['00000000-0000-4000-8000-000000000511'::uuid],
  'What is the 10% emissions target?',
  12
);

do $$
declare
  v_indexes integer[];
begin
  select array_agg(result_row.chunk_index order by result_row.chunk_index)
  into v_indexes
  from phase5_percentage_results as result_row
  where result_row.parent_chunk_id = '00000000-0000-4000-8000-000000000521';

  if not (v_indexes @> array[0, 1, 2]) then
    raise exception 'pinpoint neighbour expansion failed: %', v_indexes;
  end if;
end;
$$;

create temporary table phase5_decimal_results as
select *
from public.search_source_chunks(
  '00000000-0000-4000-8000-000000000501',
  array['00000000-0000-4000-8000-000000000511'::uuid],
  'Find the 0.10 reduction requirement',
  8
);

do $$
begin
  if not exists (
    select 1
    from phase5_decimal_results as result_row
    where result_row.content ilike '%10 percent%'
  ) then
    raise exception 'decimal-to-percentage query expansion failed';
  end if;
end;
$$;

create temporary table phase5_section_results as
select *
from public.search_source_chunks(
  '00000000-0000-4000-8000-000000000501',
  array['00000000-0000-4000-8000-000000000511'::uuid],
  'What is in the Renewable Investment section?',
  8
);

do $$
begin
  if not exists (
    select 1
    from phase5_section_results as result_row
    where result_row.heading = 'Renewable Investment'
  ) then
    raise exception 'section-aware retrieval failed';
  end if;
end;
$$;

create temporary table phase5_summary_results as
select *
from public.search_source_chunks(
  '00000000-0000-4000-8000-000000000501',
  array['00000000-0000-4000-8000-000000000511'::uuid],
  'Summarize the whole document section by section',
  12
);

do $$
begin
  if (
    select count(distinct result_row.parent_chunk_id)
    from phase5_summary_results as result_row
  ) < 2 then
    raise exception 'summary diversity failed';
  end if;
  if not exists (
    select 1
    from phase5_summary_results as result_row
    where result_row.parent_content like '%DETERMINISTIC DOCUMENT MAP%'
      and result_row.parent_content like '%COVERAGE LIMIT:%'
  ) then
    raise exception 'summary document map or coverage disclosure is missing';
  end if;
end;
$$;

create temporary table phase5_comparison_results as
select *
from public.search_source_chunks(
  '00000000-0000-4000-8000-000000000501',
  array[
    '00000000-0000-4000-8000-000000000511'::uuid,
    '00000000-0000-4000-8000-000000000512'::uuid
  ],
  'Compare the climate reduction targets across documents',
  12
);

do $$
begin
  if (
    select count(distinct result_row.document_id)
    from phase5_comparison_results as result_row
  ) <> 2 then
    raise exception 'comparison did not preserve an independent quota per document';
  end if;
end;
$$;

create temporary table phase5_timeline_results as
select *
from public.search_source_chunks(
  '00000000-0000-4000-8000-000000000501',
  array[
    '00000000-0000-4000-8000-000000000511'::uuid,
    '00000000-0000-4000-8000-000000000512'::uuid
  ],
  'Create a chronological timeline of dated events',
  12
);

do $$
declare
  v_first text;
  v_last text;
begin
  select result_row.content
  into v_first
  from phase5_timeline_results as result_row
  order by result_row.lexical_rank desc
  limit 1;

  select result_row.content
  into v_last
  from phase5_timeline_results as result_row
  order by result_row.lexical_rank asc
  limit 1;

  if v_first not like '%2024-01-01%'
    or v_last not like '%2026-04-15%' then
    raise exception 'timeline ordering failed: first=%, last=%', v_first, v_last;
  end if;
end;
$$;

create temporary table phase5_exhaustive_results as
select *
from public.search_source_chunks(
  '00000000-0000-4000-8000-000000000501',
  array['00000000-0000-4000-8000-000000000511'::uuid],
  'Extract every occurrence of targets',
  12
);

do $$
begin
  if not exists (
    select 1
    from phase5_exhaustive_results as result_row
    where result_row.parent_content like '%COVERAGE LIMIT:%'
  ) then
    raise exception 'exhaustive extraction did not disclose coverage limits';
  end if;
end;
$$;

select 'Phase 5 PostgreSQL integration passed' as result;
