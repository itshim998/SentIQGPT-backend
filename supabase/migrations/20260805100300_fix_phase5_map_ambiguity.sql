-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Fully qualifies every CTE output used by the deterministic document-map
-- builder. This removes PostgreSQL SQLSTATE 42702 ambiguity failures observed
-- by the live PostgreSQL 16 integration test, then retries failed ready maps.

create or replace function public.refresh_source_document_map(
  p_document_id uuid,
  p_owner_user_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_page_count integer := 0;
  v_parent_count integer := 0;
  v_metadata jsonb := '{}'::jsonb;
  v_clean_metadata jsonb := '{}'::jsonb;
  v_sections jsonb := '[]'::jsonb;
  v_terms jsonb := '[]'::jsonb;
  v_acronyms jsonb := '[]'::jsonb;
  v_entities jsonb := '[]'::jsonb;
  v_table_pages jsonb := '[]'::jsonb;
  v_appendix_pages jsonb := '[]'::jsonb;
  v_detected_toc boolean := false;
  v_map jsonb;
begin
  select coalesce(source_document.metadata, '{}'::jsonb)
  into v_metadata
  from public.source_documents as source_document
  where source_document.id = p_document_id
    and source_document.owner_user_id = p_owner_user_id
  for update;

  if not found then
    return;
  end if;

  select
    coalesce(max(source_chunk.page_number), 0),
    count(*) filter (where source_chunk.chunk_role = 'parent')::integer,
    coalesce(bool_or(
      source_chunk.chunk_role = 'parent'
      and source_chunk.content ~*
        '(table[[:space:]]+of[[:space:]]+contents|contents[[:space:]]*\n|\.{3,}[[:space:]]*[0-9]+)'
    ), false)
  into v_page_count, v_parent_count, v_detected_toc
  from public.source_chunks as source_chunk
  where source_chunk.document_id = p_document_id
    and source_chunk.owner_user_id = p_owner_user_id;

  v_page_count := greatest(
    v_page_count,
    case
      when coalesce(v_metadata ->> 'page_count', '') ~ '^[0-9]+$'
        then (v_metadata ->> 'page_count')::integer
      else 0
    end,
    case
      when coalesce(v_metadata ->> 'declared_page_count', '') ~ '^[0-9]+$'
        then (v_metadata ->> 'declared_page_count')::integer
      else 0
    end
  );

  with parent_rows as (
    select
      source_chunk.chunk_index,
      source_chunk.page_number,
      source_chunk.heading,
      source_chunk.path,
      source_chunk.content,
      coalesce(
        nullif(btrim(source_chunk.heading), ''),
        nullif(btrim(source_chunk.path), ''),
        case
          when source_chunk.page_number is not null
            then 'Page ' || source_chunk.page_number::text
        end,
        'Untitled section'
      ) as section_label
    from public.source_chunks as source_chunk
    where source_chunk.document_id = p_document_id
      and source_chunk.owner_user_id = p_owner_user_id
      and source_chunk.chunk_role = 'parent'
  ),
  section_groups as (
    select
      parent_rows.section_label,
      min(parent_rows.chunk_index) as first_index,
      min(parent_rows.page_number) as page_start,
      max(parent_rows.page_number) as page_end,
      count(*) as parent_chunk_count,
      (array_agg(parent_rows.content order by parent_rows.chunk_index))[1]
        as first_content,
      (array_agg(parent_rows.content order by parent_rows.chunk_index desc))[1]
        as last_content,
      bool_or(parent_rows.content ~* '\m(table|tabular|columns?)\M')
        as has_table_indicator,
      bool_or(
        coalesce(parent_rows.heading, '') ~* '\mappendix\M'
        or parent_rows.content ~* '^\s*appendix\M'
      ) as appendix_indicator
    from parent_rows
    group by parent_rows.section_label
  ),
  limited_sections as (
    select
      section_groups.section_label,
      section_groups.first_index,
      section_groups.page_start,
      section_groups.page_end,
      section_groups.parent_chunk_count,
      section_groups.first_content,
      section_groups.last_content,
      section_groups.has_table_indicator,
      section_groups.appendix_indicator
    from section_groups
    order by section_groups.first_index
    limit 160
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'heading', limited_sections.section_label,
        'level', case
          when limited_sections.section_label ~*
            '^\s*(appendix|chapter|part)\M' then 1
          when limited_sections.section_label ~
            '^\s*[0-9]+\.[0-9]+\.[0-9]+' then 3
          when limited_sections.section_label ~
            '^\s*[0-9]+\.[0-9]+' then 2
          when limited_sections.section_label ~
            '^\s*[0-9]+' then 1
          else 2
        end,
        'page_start', limited_sections.page_start,
        'page_end', limited_sections.page_end,
        'parent_chunks', limited_sections.parent_chunk_count,
        'first_sentence', public.source_first_sentence(
          limited_sections.first_content
        ),
        'last_sentence', public.source_last_sentence(
          limited_sections.last_content
        ),
        'has_table_indicator', limited_sections.has_table_indicator,
        'appendix_indicator', limited_sections.appendix_indicator
      )
      order by limited_sections.first_index
    ),
    '[]'::jsonb
  )
  into v_sections
  from limited_sections;

  with word_rows as (
    select lower(split_word.term) as term_value
    from public.source_chunks as source_chunk
    cross join lateral regexp_split_to_table(
      source_chunk.content,
      '[^[:alnum:]_-]+'
    ) as split_word(term)
    where source_chunk.document_id = p_document_id
      and source_chunk.owner_user_id = p_owner_user_id
      and source_chunk.chunk_role = 'parent'
      and length(split_word.term) between 4 and 64
      and lower(split_word.term) <> all(array[
        'that','this','with','from','have','were','which','their','there',
        'would','could','should','about','into','than','then','also','such',
        'these','those','document','section','page','pages'
      ])
  ),
  ranked_terms as (
    select
      word_rows.term_value,
      count(*) as occurrence_count
    from word_rows
    group by word_rows.term_value
    having count(*) >= 2
    order by count(*) desc, word_rows.term_value
    limit 48
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'term', ranked_terms.term_value,
        'count', ranked_terms.occurrence_count
      )
      order by ranked_terms.occurrence_count desc, ranked_terms.term_value
    ),
    '[]'::jsonb
  )
  into v_terms
  from ranked_terms;

  with acronym_matches as (
    select
      upper(regex_parts.parts[2]) as acronym_value,
      btrim(regex_parts.parts[1]) as expansion_value
    from public.source_chunks as source_chunk
    cross join lateral regexp_matches(
      source_chunk.content,
      '([A-Z][A-Za-z][A-Za-z& -]{3,80})[[:space:]]+\(([A-Z][A-Z0-9-]{1,12})\)',
      'g'
    ) as regex_parts(parts)
    where source_chunk.document_id = p_document_id
      and source_chunk.owner_user_id = p_owner_user_id
      and source_chunk.chunk_role = 'parent'
  ),
  ranked_acronyms as (
    select
      acronym_matches.acronym_value,
      min(acronym_matches.expansion_value) as expansion_value,
      count(*) as occurrence_count
    from acronym_matches
    where length(acronym_matches.acronym_value) between 2 and 12
      and length(acronym_matches.expansion_value) between 4 and 80
    group by acronym_matches.acronym_value
    order by count(*) desc, acronym_matches.acronym_value
    limit 32
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'acronym', ranked_acronyms.acronym_value,
        'expansion', ranked_acronyms.expansion_value,
        'count', ranked_acronyms.occurrence_count
      )
      order by
        ranked_acronyms.occurrence_count desc,
        ranked_acronyms.acronym_value
    ),
    '[]'::jsonb
  )
  into v_acronyms
  from ranked_acronyms;

  with entity_matches as (
    select btrim(regex_parts.parts[1]) as entity_value
    from public.source_chunks as source_chunk
    cross join lateral regexp_matches(
      source_chunk.content,
      '\m([A-Z][a-z]{2,}(?:[[:space:]]+[A-Z][A-Za-z&.-]{2,}){1,4})\M',
      'g'
    ) as regex_parts(parts)
    where source_chunk.document_id = p_document_id
      and source_chunk.owner_user_id = p_owner_user_id
      and source_chunk.chunk_role = 'parent'
  ),
  ranked_entities as (
    select
      entity_matches.entity_value,
      count(*) as occurrence_count
    from entity_matches
    where length(entity_matches.entity_value) between 5 and 120
    group by entity_matches.entity_value
    having count(*) >= 2
    order by count(*) desc, entity_matches.entity_value
    limit 32
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'entity', ranked_entities.entity_value,
        'count', ranked_entities.occurrence_count
      )
      order by
        ranked_entities.occurrence_count desc,
        ranked_entities.entity_value
    ),
    '[]'::jsonb
  )
  into v_entities
  from ranked_entities;

  select coalesce(
    jsonb_agg(
      table_page_rows.page_number
      order by table_page_rows.page_number
    ),
    '[]'::jsonb
  )
  into v_table_pages
  from (
    select distinct source_chunk.page_number
    from public.source_chunks as source_chunk
    where source_chunk.document_id = p_document_id
      and source_chunk.owner_user_id = p_owner_user_id
      and source_chunk.chunk_role = 'parent'
      and source_chunk.page_number is not null
      and (
        source_chunk.content ~* '\mtable[[:space:]]+[0-9]+'
        or source_chunk.content ~* '\m(tabular|columns?)\M'
        or source_chunk.content like '%|%|%'
      )
    order by source_chunk.page_number
    limit 120
  ) as table_page_rows;

  select coalesce(
    jsonb_agg(
      appendix_page_rows.page_number
      order by appendix_page_rows.page_number
    ),
    '[]'::jsonb
  )
  into v_appendix_pages
  from (
    select distinct source_chunk.page_number
    from public.source_chunks as source_chunk
    where source_chunk.document_id = p_document_id
      and source_chunk.owner_user_id = p_owner_user_id
      and source_chunk.chunk_role = 'parent'
      and source_chunk.page_number is not null
      and (
        coalesce(source_chunk.heading, '') ~* '\mappendix\M'
        or source_chunk.content ~* '^\s*appendix\M'
      )
    order by source_chunk.page_number
    limit 120
  ) as appendix_page_rows;

  v_map := jsonb_build_object(
    'version', 1,
    'generated_at', now(),
    'page_count', v_page_count,
    'parent_chunk_count', v_parent_count,
    'detected_table_of_contents', v_detected_toc,
    'table_of_contents', case
      when v_detected_toc then v_sections
      else '[]'::jsonb
    end,
    'heading_hierarchy', v_sections,
    'sections', v_sections,
    'repeated_key_terms', v_terms,
    'repeated_entities', v_entities,
    'acronym_expansions', v_acronyms,
    'table_pages', v_table_pages,
    'appendix_pages', v_appendix_pages
  );

  v_clean_metadata := coalesce(v_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'document_map_version', 1,
      'document_map_status', 'ready'
    );
  v_clean_metadata := v_clean_metadata - 'document_map_failure_type';
  v_clean_metadata := v_clean_metadata - 'document_map_failure_message';
  v_clean_metadata := v_clean_metadata - 'document_map_failure_detail';
  v_clean_metadata := v_clean_metadata - 'document_map_failure_hint';
  v_clean_metadata := v_clean_metadata - 'document_map_failure_context';

  update public.source_documents as source_document
  set metadata = jsonb_set(
    v_clean_metadata,
    '{document_map}',
    v_map,
    true
  )
  where source_document.id = p_document_id
    and source_document.owner_user_id = p_owner_user_id;
end;
$$;

-- Retry ready documents whose earlier map attempt failed or produced no map.
-- Each document remains failure-isolated so one legacy anomaly cannot roll back
-- maps completed for other sources.
do $$
declare
  v_document record;
  v_failure_message text;
  v_failure_detail text;
  v_failure_hint text;
  v_failure_context text;
begin
  for v_document in
    select source_document.id, source_document.owner_user_id
    from public.source_documents as source_document
    where source_document.status = 'ready'
      and (
        jsonb_typeof(
          coalesce(
            source_document.metadata -> 'document_map',
            'null'::jsonb
          )
        ) is distinct from 'object'
        or coalesce(
          source_document.metadata ->> 'document_map_status',
          ''
        ) <> 'ready'
      )
    order by source_document.created_at
  loop
    begin
      perform public.refresh_source_document_map(
        v_document.id,
        v_document.owner_user_id
      );
    exception when others then
      get stacked diagnostics
        v_failure_message = message_text,
        v_failure_detail = pg_exception_detail,
        v_failure_hint = pg_exception_hint,
        v_failure_context = pg_exception_context;

      update public.source_documents as source_document
      set metadata = coalesce(source_document.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'document_map_status', 'failed',
          'document_map_failure_type', sqlstate,
          'document_map_failure_message',
            left(coalesce(v_failure_message, ''), 1000),
          'document_map_failure_detail',
            left(coalesce(v_failure_detail, ''), 1000),
          'document_map_failure_hint',
            left(coalesce(v_failure_hint, ''), 1000),
          'document_map_failure_context',
            left(coalesce(v_failure_context, ''), 4000)
        )
      where source_document.id = v_document.id
        and source_document.owner_user_id = v_document.owner_user_id;
    end;
  end loop;
end;
$$;

revoke all on function public.refresh_source_document_map(uuid, uuid)
  from public, anon;

grant execute on function public.refresh_source_document_map(uuid, uuid)
  to authenticated, service_role;

comment on function public.refresh_source_document_map(uuid, uuid) is
  'Builds a fully qualified bounded deterministic map and retries prior SQLSTATE 42702 failures safely.';
