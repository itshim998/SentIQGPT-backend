-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Hardens Phase 5 document-map generation and query normalization after the
-- core weighted-FTS migration has installed the public contracts.

create or replace function public.source_first_sentence(p_text text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := regexp_replace(btrim(coalesce(p_text, '')), '[[:space:]]+', ' ', 'g');
  v_match text[];
begin
  if v_text = '' then
    return '';
  end if;
  v_match := regexp_match(v_text, '^(.{1,500}?[.!?])(?:[[:space:]]|$)');
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
  v_text text := regexp_replace(btrim(coalesce(p_text, '')), '[[:space:]]+', ' ', 'g');
  v_match text[];
  v_last text := '';
begin
  if v_text = '' then
    return '';
  end if;
  for v_match in
    select parts
    from regexp_matches(v_text, '([^.!?]{1,500}[.!?])(?:[[:space:]]|$)', 'g') as matched(parts)
  loop
    v_last := btrim(v_match[1]);
  end loop;
  return right(case when v_last <> '' then v_last else v_text end, 500);
end;
$$;

create or replace function public.source_expand_query_terms(
  p_owner_user_id uuid,
  p_document_ids uuid[],
  p_query text
)
returns text[]
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_normalized text := lower(left(coalesce(p_query, ''), 2000));
  v_token text;
  v_base text;
  v_number numeric;
  v_percent text;
  v_terms text[] := array[]::text[];
  v_match text[];
  v_acronym record;
  v_stop constant text[] := array[
    'the','and','for','with','that','this','from','what','when','where','which',
    'about','into','does','did','are','was','were','has','have','had','how','why',
    'summarize','summary','overview','document','documents','file','files','pdf',
    'timeline','chronology','chronological','compare','comparison','section','chapter'
  ];
begin
  v_normalized := regexp_replace(v_normalized, '[-_/]+', ' ', 'g');

  for v_token in
    select btrim(term)
    from regexp_split_to_table(v_normalized, '[^[:alnum:]%.]+') as split(term)
  loop
    if length(v_token) < 2 or v_token = any(v_stop) then
      continue;
    end if;

    v_terms := array_append(v_terms, v_token);

    if v_token ~ '^[0-9]+(?:\.[0-9]+)?%$' then
      v_base := regexp_replace(v_token, '%$', '');
      v_terms := array_append(v_terms, v_base);
      v_terms := array_append(v_terms, v_base || ' percent');
      begin
        v_number := v_base::numeric / 100;
        v_terms := array_append(
          v_terms,
          trim(trailing '.' from trim(trailing '0' from round(v_number, 8)::text))
        );
      exception when others then
        null;
      end;
    elsif v_token ~ '^[0-9]+(?:\.[0-9]+)?$' then
      v_terms := array_append(v_terms, v_token || '%');
      v_terms := array_append(v_terms, v_token || ' percent');
      begin
        v_number := v_token::numeric;
        if v_number > 0 and v_number <= 1 then
          v_percent := trim(
            trailing '.' from trim(
              trailing '0' from round(v_number * 100, 8)::text
            )
          );
          v_terms := array_append(v_terms, v_percent);
          v_terms := array_append(v_terms, v_percent || '%');
          v_terms := array_append(v_terms, v_percent || ' percent');
        end if;
      exception when others then
        null;
      end;
    elsif v_token ~ '^[[:alpha:]]{4,}$' then
      if v_token ~ 'ies$' and length(v_token) > 4 then
        v_terms := array_append(v_terms, left(v_token, length(v_token) - 3) || 'y');
      elsif v_token ~ 'es$' and length(v_token) > 4 then
        v_terms := array_append(v_terms, left(v_token, length(v_token) - 2));
      elsif v_token ~ 's$' and length(v_token) > 3 then
        v_terms := array_append(v_terms, left(v_token, length(v_token) - 1));
      else
        v_terms := array_append(v_terms, v_token || 's');
        if v_token ~ '[sxz]$' or v_token ~ '(ch|sh)$' then
          v_terms := array_append(v_terms, v_token || 'es');
        end if;
      end if;
    end if;
  end loop;

  for v_match in
    select parts
    from regexp_matches(
      coalesce(p_query, ''),
      '([[:alnum:]]+)-([[:alnum:]]+)',
      'g'
    ) as matched(parts)
  loop
    v_terms := array_append(v_terms, lower(v_match[1] || v_match[2]));
    v_terms := array_append(v_terms, lower(v_match[1] || ' ' || v_match[2]));
  end loop;

  for v_acronym in
    select
      upper(item ->> 'acronym') as acronym,
      lower(item ->> 'expansion') as expansion
    from public.source_documents document
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(document.metadata -> 'document_map' -> 'acronym_expansions') = 'array'
          then document.metadata -> 'document_map' -> 'acronym_expansions'
        else '[]'::jsonb
      end
    ) as acronyms(item)
    where document.owner_user_id = p_owner_user_id
      and document.id = any(coalesce(p_document_ids, array[]::uuid[]))
      and document.status = 'ready'
      and jsonb_typeof(item) = 'object'
  loop
    if v_acronym.acronym is null or v_acronym.expansion is null then
      continue;
    end if;
    if v_normalized ~ ('\m' || lower(v_acronym.acronym) || '\M')
      or position(v_acronym.expansion in v_normalized) > 0 then
      v_terms := array_append(v_terms, lower(v_acronym.acronym));
      v_terms := v_terms || regexp_split_to_array(
        v_acronym.expansion,
        '[^[:alnum:]]+'
      );
    end if;
  end loop;

  return coalesce(
    array(
      select distinct btrim(term)
      from unnest(v_terms) as expanded(term)
      where length(btrim(term)) >= 2
      order by btrim(term)
      limit 64
    ),
    array[]::text[]
  );
end;
$$;

create or replace function public.source_extract_sort_date(p_text text)
returns date
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_match text[];
  v_candidate text;
begin
  v_match := regexp_match(
    coalesce(p_text, ''),
    '\m((?:19|20)[0-9]{2})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})\M'
  );
  if v_match is not null then
    begin
      return make_date(v_match[1]::integer, v_match[2]::integer, v_match[3]::integer);
    exception when others then
      null;
    end;
  end if;

  v_match := regexp_match(
    coalesce(p_text, ''),
    '\m([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]((?:19|20)[0-9]{2})\M'
  );
  if v_match is not null then
    begin
      return make_date(v_match[3]::integer, v_match[2]::integer, v_match[1]::integer);
    exception when others then
      null;
    end;
  end if;

  v_candidate := substring(
    coalesce(p_text, '')
    from '\m((?:January|February|March|April|May|June|July|August|September|October|November|December)[[:space:]]+[0-9]{1,2},?[[:space:]]+(?:19|20)[0-9]{2})\M'
  );
  if v_candidate is not null then
    begin
      return to_date(replace(v_candidate, ',', ''), 'Month DD YYYY');
    exception when others then
      null;
    end;
  end if;

  return null;
end;
$$;

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
  v_sections jsonb := '[]'::jsonb;
  v_terms jsonb := '[]'::jsonb;
  v_acronyms jsonb := '[]'::jsonb;
  v_entities jsonb := '[]'::jsonb;
  v_table_pages jsonb := '[]'::jsonb;
  v_appendix_pages jsonb := '[]'::jsonb;
  v_detected_toc boolean := false;
  v_map jsonb;
begin
  select coalesce(document.metadata, '{}'::jsonb)
  into v_metadata
  from public.source_documents document
  where document.id = p_document_id
    and document.owner_user_id = p_owner_user_id
  for update;

  if not found then
    return;
  end if;

  select
    coalesce(max(chunk.page_number), 0),
    count(*) filter (where chunk.chunk_role = 'parent')::integer,
    coalesce(bool_or(
      chunk.chunk_role = 'parent'
      and chunk.content ~* '(table[[:space:]]+of[[:space:]]+contents|contents[[:space:]]*\n|\.{3,}[[:space:]]*[0-9]+)'
    ), false)
  into v_page_count, v_parent_count, v_detected_toc
  from public.source_chunks chunk
  where chunk.document_id = p_document_id
    and chunk.owner_user_id = p_owner_user_id;

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

  with parents as (
    select
      chunk.chunk_index,
      chunk.page_number,
      chunk.heading,
      chunk.path,
      chunk.content,
      coalesce(
        nullif(btrim(chunk.heading), ''),
        nullif(btrim(chunk.path), ''),
        case when chunk.page_number is not null then 'Page ' || chunk.page_number::text end,
        'Untitled section'
      ) as section_label
    from public.source_chunks chunk
    where chunk.document_id = p_document_id
      and chunk.owner_user_id = p_owner_user_id
      and chunk.chunk_role = 'parent'
  ),
  section_groups as (
    select
      section_label,
      min(chunk_index) as first_index,
      min(page_number) as page_start,
      max(page_number) as page_end,
      count(*) as parent_chunks,
      (array_agg(content order by chunk_index))[1] as first_content,
      (array_agg(content order by chunk_index desc))[1] as last_content,
      bool_or(content ~* '\m(table|tabular|columns?)\M') as has_table_indicator,
      bool_or(
        coalesce(heading, '') ~* '\mappendix\M'
        or content ~* '^\s*appendix\M'
      ) as appendix_indicator
    from parents
    group by section_label
  ),
  limited as (
    select *
    from section_groups
    order by first_index
    limit 160
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'heading', section_label,
      'level', case
        when section_label ~* '^\s*(appendix|chapter|part)\M' then 1
        when section_label ~ '^\s*[0-9]+\.[0-9]+\.[0-9]+' then 3
        when section_label ~ '^\s*[0-9]+\.[0-9]+' then 2
        when section_label ~ '^\s*[0-9]+' then 1
        else 2
      end,
      'page_start', page_start,
      'page_end', page_end,
      'parent_chunks', parent_chunks,
      'first_sentence', public.source_first_sentence(first_content),
      'last_sentence', public.source_last_sentence(last_content),
      'has_table_indicator', has_table_indicator,
      'appendix_indicator', appendix_indicator
    ) order by first_index
  ), '[]'::jsonb)
  into v_sections
  from limited;

  with words as (
    select lower(word) as word
    from public.source_chunks chunk
    cross join lateral regexp_split_to_table(
      chunk.content,
      '[^[:alnum:]_-]+'
    ) as split(word)
    where chunk.document_id = p_document_id
      and chunk.owner_user_id = p_owner_user_id
      and chunk.chunk_role = 'parent'
      and length(word) between 4 and 64
      and lower(word) <> all(array[
        'that','this','with','from','have','were','which','their','there','would','could','should',
        'about','into','than','then','also','such','these','those','document','section','page','pages'
      ])
  ),
  ranked as (
    select word, count(*) as occurrences
    from words
    group by word
    having count(*) >= 2
    order by occurrences desc, word
    limit 48
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('term', word, 'count', occurrences)
    order by occurrences desc, word
  ), '[]'::jsonb)
  into v_terms
  from ranked;

  with matches as (
    select upper(parts[2]) as acronym, btrim(parts[1]) as expansion
    from public.source_chunks chunk
    cross join lateral regexp_matches(
      chunk.content,
      '([A-Z][A-Za-z][A-Za-z& -]{3,80})[[:space:]]+\(([A-Z][A-Z0-9-]{1,12})\)',
      'g'
    ) as matched(parts)
    where chunk.document_id = p_document_id
      and chunk.owner_user_id = p_owner_user_id
      and chunk.chunk_role = 'parent'
  ),
  deduped as (
    select acronym, min(expansion) as expansion, count(*) as occurrences
    from matches
    where length(acronym) between 2 and 12
      and length(expansion) between 4 and 80
    group by acronym
    order by occurrences desc, acronym
    limit 32
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('acronym', acronym, 'expansion', expansion, 'count', occurrences)
    order by occurrences desc, acronym
  ), '[]'::jsonb)
  into v_acronyms
  from deduped;

  with matches as (
    select btrim(parts[1]) as entity
    from public.source_chunks chunk
    cross join lateral regexp_matches(
      chunk.content,
      '\m([A-Z][a-z]{2,}(?:[[:space:]]+[A-Z][A-Za-z&.-]{2,}){1,4})\M',
      'g'
    ) as matched(parts)
    where chunk.document_id = p_document_id
      and chunk.owner_user_id = p_owner_user_id
      and chunk.chunk_role = 'parent'
  ),
  ranked as (
    select entity, count(*) as occurrences
    from matches
    where length(entity) between 5 and 120
    group by entity
    having count(*) >= 2
    order by occurrences desc, entity
    limit 32
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('entity', entity, 'count', occurrences)
    order by occurrences desc, entity
  ), '[]'::jsonb)
  into v_entities
  from ranked;

  select coalesce(jsonb_agg(page_number order by page_number), '[]'::jsonb)
  into v_table_pages
  from (
    select distinct chunk.page_number
    from public.source_chunks chunk
    where chunk.document_id = p_document_id
      and chunk.owner_user_id = p_owner_user_id
      and chunk.chunk_role = 'parent'
      and chunk.page_number is not null
      and (
        chunk.content ~* '\mtable[[:space:]]+[0-9]+'
        or chunk.content ~* '\m(tabular|columns?)\M'
        or chunk.content like '%|%|%'
      )
    order by chunk.page_number
    limit 120
  ) table_pages;

  select coalesce(jsonb_agg(page_number order by page_number), '[]'::jsonb)
  into v_appendix_pages
  from (
    select distinct chunk.page_number
    from public.source_chunks chunk
    where chunk.document_id = p_document_id
      and chunk.owner_user_id = p_owner_user_id
      and chunk.chunk_role = 'parent'
      and chunk.page_number is not null
      and (
        coalesce(chunk.heading, '') ~* '\mappendix\M'
        or chunk.content ~* '^\s*appendix\M'
      )
    order by chunk.page_number
    limit 120
  ) appendix_pages;

  v_map := jsonb_build_object(
    'version', 1,
    'generated_at', now(),
    'page_count', v_page_count,
    'parent_chunk_count', v_parent_count,
    'detected_table_of_contents', v_detected_toc,
    'table_of_contents', case when v_detected_toc then v_sections else '[]'::jsonb end,
    'heading_hierarchy', v_sections,
    'sections', v_sections,
    'repeated_key_terms', v_terms,
    'repeated_entities', v_entities,
    'acronym_expansions', v_acronyms,
    'table_pages', v_table_pages,
    'appendix_pages', v_appendix_pages
  );

  update public.source_documents document
  set metadata = jsonb_set(
    coalesce(document.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'document_map_version', 1,
        'document_map_status', 'ready'
      ) - 'document_map_failure_type',
    '{document_map}',
    v_map,
    true
  )
  where document.id = p_document_id
    and document.owner_user_id = p_owner_user_id;
end;
$$;

-- Backfill independently so one unusual legacy document cannot roll back maps
-- already built for other ready sources.
do $$
declare
  v_document record;
begin
  for v_document in
    select document.id, document.owner_user_id
    from public.source_documents document
    where document.status = 'ready'
      and (
        jsonb_typeof(coalesce(document.metadata -> 'document_map', 'null'::jsonb)) is distinct from 'object'
        or coalesce(document.metadata ->> 'document_map_status', '') <> 'ready'
      )
    order by document.created_at
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
end;
$$;

revoke all on function public.source_first_sentence(text) from public, anon;
revoke all on function public.source_last_sentence(text) from public, anon;
revoke all on function public.refresh_source_document_map_on_ready() from public, anon;

grant execute on function public.source_first_sentence(text) to authenticated, service_role;
grant execute on function public.source_last_sentence(text) to authenticated, service_role;

comment on function public.refresh_source_document_map(uuid, uuid) is
  'Builds a bounded deterministic map with guarded metadata parsing and sentence-level section representatives.';
