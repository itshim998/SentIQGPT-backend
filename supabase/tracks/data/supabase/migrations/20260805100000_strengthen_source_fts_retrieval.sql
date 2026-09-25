-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Phase 5 strengthens persisted long-document retrieval without embeddings or
-- additional model calls. It adds weighted PostgreSQL FTS, deterministic query
-- expansion, neighbour expansion, retrieval-mode quotas, and an ingestion-time
-- document map stored in source_documents.metadata.

alter table public.source_chunks
  add column if not exists fts_weighted tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(path, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(context_prefix, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'D')
  ) stored;

create index if not exists source_chunks_fts_weighted_idx
  on public.source_chunks using gin(fts_weighted);

create or replace function public.source_infer_retrieval_mode(
  p_query text,
  p_document_count integer
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when lower(coalesce(p_query, '')) ~
      '\m(exhaustive|extract every|all occurrences|every occurrence|complete extraction|all mentions|all instances)\M'
      then 'exhaustive'
    when lower(coalesce(p_query, '')) ~
      '\m(timeline|chronology|chronological|sequence of events|dated events|event history)\M'
      then 'timeline'
    when greatest(coalesce(p_document_count, 0), 0) > 1
      and lower(coalesce(p_query, '')) ~
        '\m(compare|comparison|contrast|differences|difference|versus|vs|across documents|between documents|each document)\M'
      then 'comparison'
    when lower(coalesce(p_query, '')) ~
      '\m(summarize|summary|overview|whole document|entire document|full document|section by section|all sections|complete report|broad analysis)\M'
      then 'summary'
    when lower(coalesce(p_query, '')) ~
      '\m(section|chapter|appendix|part|heading|under the heading|in the section)\M'
      then 'section'
    else 'pinpoint'
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
      coalesce(document.metadata -> 'document_map' -> 'acronym_expansions', '[]'::jsonb)
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
      select distinct term
      from unnest(v_terms) as expanded(term)
      where length(btrim(term)) >= 2
      order by term
      limit 64
    ),
    array[]::text[]
  );
end;
$$;

create or replace function public.source_build_expanded_tsquery(
  p_owner_user_id uuid,
  p_document_ids uuid[],
  p_query text
)
returns tsquery
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_term text;
  v_piece tsquery;
  v_result tsquery;
begin
  for v_term in
    select unnest(
      public.source_expand_query_terms(p_owner_user_id, p_document_ids, p_query)
    )
  loop
    v_piece := plainto_tsquery('simple', v_term);
    if numnode(v_piece) = 0 then
      continue;
    end if;
    if v_result is null or numnode(v_result) = 0 then
      v_result := v_piece;
    else
      v_result := v_result || v_piece;
    end if;
  end loop;
  return coalesce(v_result, plainto_tsquery('simple', coalesce(p_query, '')));
end;
$$;

create or replace function public.source_exact_phrase_boost(
  p_text text,
  p_query text
)
returns real
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(sum(
    case
      when position(lower(parts[1]) in lower(coalesce(p_text, ''))) > 0 then 1.5
      else 0
    end
  ), 0)::real
  from regexp_matches(
    coalesce(p_query, ''),
    '"([^"\n]{2,160})"',
    'g'
  ) as matched(parts);
$$;

create or replace function public.source_special_term_boost(
  p_text text,
  p_query text
)
returns real
language sql
immutable
set search_path = public, pg_temp
as $$
  select least(4.0, coalesce(sum(
    case
      when position(lower(parts[1]) in lower(coalesce(p_text, ''))) > 0 then 0.75
      else 0
    end
  ), 0))::real
  from regexp_matches(
    coalesce(p_query, ''),
    '([0-9]+(?:\.[0-9]+)?%?|(?:19|20)[0-9]{2}(?:[-/.][0-9]{1,2}){0,2}|[A-Z]{2,}[A-Z0-9-]*|[A-Za-z]{2,}-[0-9A-Za-z-]+)',
    'g'
  ) as matched(parts);
$$;

create or replace function public.source_extract_sort_date(p_text text)
returns date
language plpgsql
immutable
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
  v_sections jsonb := '[]'::jsonb;
  v_terms jsonb := '[]'::jsonb;
  v_acronyms jsonb := '[]'::jsonb;
  v_entities jsonb := '[]'::jsonb;
  v_table_pages jsonb := '[]'::jsonb;
  v_appendix_pages jsonb := '[]'::jsonb;
  v_detected_toc boolean := false;
  v_map jsonb;
begin
  select
    greatest(
      coalesce(max(chunk.page_number), 0),
      coalesce((document.metadata ->> 'page_count')::integer, 0),
      coalesce((document.metadata ->> 'declared_page_count')::integer, 0)
    ),
    count(*) filter (where chunk.chunk_role = 'parent'),
    coalesce(bool_or(
      chunk.chunk_role = 'parent'
      and chunk.content ~* '(table[[:space:]]+of[[:space:]]+contents|contents[[:space:]]*\n|\.{3,}[[:space:]]*[0-9]+)'
    ), false)
  into v_page_count, v_parent_count, v_detected_toc
  from public.source_documents document
  left join public.source_chunks chunk
    on chunk.document_id = document.id
   and chunk.owner_user_id = document.owner_user_id
  where document.id = p_document_id
    and document.owner_user_id = p_owner_user_id
  group by document.metadata;

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
      'first_sentence', left(
        regexp_replace(coalesce(first_content, ''), '[[:space:]]+', ' ', 'g'),
        280
      ),
      'last_sentence', right(
        regexp_replace(coalesce(last_content, ''), '[[:space:]]+', ' ', 'g'),
        280
      ),
      'has_table_indicator', has_table_indicator,
      'appendix_indicator', appendix_indicator
    )
    order by first_index
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
    select
      upper(parts[2]) as acronym,
      btrim(parts[1]) as expansion
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
    jsonb_build_object(
      'acronym', acronym,
      'expansion', expansion,
      'count', occurrences
    ) order by occurrences desc, acronym
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
      ),
    '{document_map}',
    v_map,
    true
  )
  where document.id = p_document_id
    and document.owner_user_id = p_owner_user_id;
end;
$$;

create or replace function public.refresh_source_document_map_on_ready()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'ready'
    and (
      old.status is distinct from new.status
      or coalesce(new.metadata ->> 'document_map_version', '') <> '1'
    ) then
    perform public.refresh_source_document_map(new.id, new.owner_user_id);
  end if;
  return new;
exception when others then
  update public.source_documents document
  set metadata = coalesce(document.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'document_map_status', 'failed',
      'document_map_failure_type', sqlstate
    )
  where document.id = new.id
    and document.owner_user_id = new.owner_user_id;
  return new;
end;
$$;

drop trigger if exists source_documents_refresh_map_on_ready on public.source_documents;
create trigger source_documents_refresh_map_on_ready
after update of status on public.source_documents
for each row
execute function public.refresh_source_document_map_on_ready();

create or replace function public.source_document_map_text(
  p_metadata jsonb,
  p_title text,
  p_mode text,
  p_selected_sections integer,
  p_available_sections integer
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_map jsonb := coalesce(p_metadata -> 'document_map', '{}'::jsonb);
  v_section jsonb;
  v_lines text[] := array[]::text[];
  v_terms text;
  v_acronyms text;
  v_entities text;
  v_section_count integer := 0;
  v_coverage text := '';
begin
  if jsonb_typeof(v_map) <> 'object' then
    return '';
  end if;

  v_lines := array_append(v_lines, '[DETERMINISTIC DOCUMENT MAP — generated without a model]');
  v_lines := array_append(v_lines, 'Document: ' || coalesce(p_title, 'Untitled'));
  v_lines := array_append(v_lines, 'Pages: ' || coalesce(v_map ->> 'page_count', 'unknown'));
  v_lines := array_append(
    v_lines,
    'Detected table of contents: '
      || coalesce(v_map ->> 'detected_table_of_contents', 'false')
  );

  for v_section in
    select value
    from jsonb_array_elements(
      coalesce(v_map -> 'sections', '[]'::jsonb)
    ) as sections(value)
    limit 36
  loop
    v_section_count := v_section_count + 1;
    v_lines := array_append(
      v_lines,
      format(
        '- %s (pages %s–%s): %s … %s',
        coalesce(v_section ->> 'heading', 'Untitled section'),
        coalesce(v_section ->> 'page_start', '?'),
        coalesce(
          v_section ->> 'page_end',
          coalesce(v_section ->> 'page_start', '?')
        ),
        left(coalesce(v_section ->> 'first_sentence', ''), 150),
        right(coalesce(v_section ->> 'last_sentence', ''), 150)
      )
    );
  end loop;

  select string_agg(
    item ->> 'term',
    ', ' order by (item ->> 'count')::integer desc, item ->> 'term'
  )
  into v_terms
  from jsonb_array_elements(
    coalesce(v_map -> 'repeated_key_terms', '[]'::jsonb)
  ) as items(item)
  where jsonb_typeof(item) = 'object';
  if v_terms is not null then
    v_lines := array_append(v_lines, 'Repeated key terms: ' || left(v_terms, 700));
  end if;

  select string_agg(
    item ->> 'entity',
    ', ' order by (item ->> 'count')::integer desc, item ->> 'entity'
  )
  into v_entities
  from jsonb_array_elements(
    coalesce(v_map -> 'repeated_entities', '[]'::jsonb)
  ) as items(item)
  where jsonb_typeof(item) = 'object';
  if v_entities is not null then
    v_lines := array_append(v_lines, 'Repeated entities: ' || left(v_entities, 700));
  end if;

  select string_agg(
    format('%s = %s', item ->> 'acronym', item ->> 'expansion'),
    '; ' order by item ->> 'acronym'
  )
  into v_acronyms
  from jsonb_array_elements(
    coalesce(v_map -> 'acronym_expansions', '[]'::jsonb)
  ) as items(item)
  where jsonb_typeof(item) = 'object';
  if v_acronyms is not null then
    v_lines := array_append(v_lines, 'Acronyms: ' || left(v_acronyms, 700));
  end if;

  if p_mode in ('summary', 'exhaustive') then
    v_coverage := format(
      '[COVERAGE LIMIT: retrieval selected representative evidence from %s of approximately %s mapped sections. The model did not inspect every page simultaneously.]',
      greatest(coalesce(p_selected_sections, 0), 0),
      greatest(coalesce(p_available_sections, v_section_count), v_section_count)
    );
    v_lines := array_append(v_lines, v_coverage);
  end if;

  return left(array_to_string(v_lines, E'\n'), 12000);
end;
$$;

create or replace function public.search_source_chunks(
  p_owner_user_id uuid,
  p_document_ids uuid[],
  p_query text,
  p_limit integer default 12
)
returns table (
  chunk_id uuid,
  document_id uuid,
  parent_chunk_id uuid,
  title text,
  chunk_index integer,
  heading text,
  path text,
  page_number integer,
  content text,
  context_prefix text,
  token_estimate integer,
  parent_content text,
  parent_context_prefix text,
  lexical_rank real
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 12), 50));
  v_document_count integer := greatest(
    cardinality(coalesce(p_document_ids, array[]::uuid[])),
    1
  );
  v_mode text := public.source_infer_retrieval_mode(
    p_query,
    cardinality(coalesce(p_document_ids, array[]::uuid[]))
  );
  v_original_query tsquery := websearch_to_tsquery(
    'simple',
    left(coalesce(p_query, ''), 2000)
  );
  v_expanded_query tsquery := public.source_build_expanded_tsquery(
    p_owner_user_id,
    p_document_ids,
    p_query
  );
  v_per_document integer;
begin
  v_per_document := greatest(
    2,
    ceil(v_limit::numeric / v_document_count)::integer
  );

  return query
  with base as (
    select
      child.id as chunk_id,
      child.document_id,
      child.parent_chunk_id,
      document.title,
      document.metadata as document_metadata,
      child.chunk_index,
      child.heading,
      child.path,
      child.page_number,
      child.content,
      child.context_prefix,
      child.token_estimate,
      child.fts_weighted,
      parent.content as parent_content,
      parent.context_prefix as parent_context_prefix,
      min(child.chunk_index) over (
        partition by child.parent_chunk_id
      ) as first_child_index,
      max(child.chunk_index) over (
        partition by child.parent_chunk_id
      ) as last_child_index,
      public.source_extract_sort_date(child.content) as sort_date
    from public.source_chunks child
    join public.source_chunks parent
      on parent.id = child.parent_chunk_id
     and parent.document_id = child.document_id
     and parent.chunk_role = 'parent'
    join public.source_documents document
      on document.id = child.document_id
     and document.owner_user_id = child.owner_user_id
    where child.owner_user_id = p_owner_user_id
      and child.document_id = any(coalesce(p_document_ids, array[]::uuid[]))
      and child.chunk_role = 'child'
      and document.status = 'ready'
  ),
  available_counts as (
    select
      document_id,
      count(distinct parent_chunk_id)::integer as available_parent_count
    from base
    group by document_id
  ),
  scored as (
    select
      base.*,
      (
        case when numnode(v_original_query) > 0
          then ts_rank_cd(base.fts_weighted, v_original_query) * 4.0
          else 0 end
        + case when numnode(v_expanded_query) > 0
          then ts_rank_cd(base.fts_weighted, v_expanded_query) * 1.35
          else 0 end
        + case when numnode(v_original_query) > 0
          then ts_rank_cd(
            to_tsvector('simple', coalesce(base.title, '')),
            v_original_query
          ) * 1.75
          else 0 end
        + public.source_exact_phrase_boost(
            concat_ws(' ', base.title, base.heading, base.path, base.content),
            p_query
          )
        + public.source_special_term_boost(
            concat_ws(' ', base.title, base.heading, base.path, base.content),
            p_query
          )
        + case
            when v_mode = 'section'
              and numnode(v_expanded_query) > 0
              and to_tsvector(
                'simple',
                concat_ws(' ', base.heading, base.path, base.context_prefix)
              ) @@ v_expanded_query
              then 2.0
            else 0
          end
        + case when base.heading is not null then 0.05 else 0 end
      )::real as score,
      (
        (numnode(v_original_query) > 0 and base.fts_weighted @@ v_original_query)
        or (numnode(v_expanded_query) > 0 and base.fts_weighted @@ v_expanded_query)
      ) as lexical_match,
      (
        (
          numnode(v_original_query) > 0
          and to_tsvector(
            'simple',
            concat_ws(' ', base.heading, base.path, base.context_prefix)
          ) @@ v_original_query
        )
        or (
          numnode(v_expanded_query) > 0
          and to_tsvector(
            'simple',
            concat_ws(' ', base.heading, base.path, base.context_prefix)
          ) @@ v_expanded_query
        )
      ) as section_match
    from base
  ),
  eligible as (
    select *
    from scored
    where case v_mode
      when 'summary' then chunk_index in (first_child_index, last_child_index)
      when 'comparison' then lexical_match or chunk_index = first_child_index
      when 'timeline' then sort_date is not null
      when 'exhaustive' then chunk_index = first_child_index
      when 'section' then section_match
        or (
          lexical_match
          and not exists (
            select 1
            from scored section_candidate
            where section_candidate.section_match
          )
        )
      else lexical_match
    end
  ),
  ranked as (
    select
      eligible.*,
      row_number() over (
        partition by document_id, parent_chunk_id
        order by score desc, chunk_index
      ) as parent_rank,
      row_number() over (
        partition by document_id
        order by score desc, coalesce(page_number, 2147483647), chunk_index
      ) as document_rank,
      row_number() over (
        partition by document_id, page_number
        order by score desc, chunk_index
      ) as page_rank,
      ntile(v_per_document) over (
        partition by document_id
        order by coalesce(page_number, 2147483647), chunk_index
      ) as diversity_bucket,
      dense_rank() over (order by document_id) as document_ordinal
    from eligible
  ),
  bucketed as (
    select
      ranked.*,
      row_number() over (
        partition by document_id, diversity_bucket
        order by score desc, coalesce(page_number, 2147483647), chunk_index
      ) as bucket_rank
    from ranked
  ),
  anchor_candidates as (
    select *
    from bucketed
    where case v_mode
      when 'summary' then bucket_rank = 1 and parent_rank = 1
      when 'exhaustive' then bucket_rank = 1 and parent_rank = 1
      when 'comparison' then
        document_rank <= v_per_document and parent_rank <= 2 and page_rank <= 2
      when 'timeline' then parent_rank = 1 and page_rank <= 2
      when 'section' then parent_rank <= 3 and page_rank <= 2
      else parent_rank <= 2 and page_rank <= 2
    end
  ),
  anchors as (
    select *
    from anchor_candidates
    order by
      case when v_mode = 'timeline' then sort_date end asc nulls last,
      case when v_mode in ('summary', 'exhaustive')
        then diversity_bucket end asc nulls last,
      case when v_mode = 'comparison' then document_rank end asc nulls last,
      score desc,
      document_id,
      chunk_index
    limit v_limit
  ),
  expanded as (
    select
      anchor.chunk_id,
      anchor.document_id,
      anchor.parent_chunk_id,
      anchor.title,
      anchor.document_metadata,
      anchor.chunk_index,
      anchor.heading,
      anchor.path,
      anchor.page_number,
      anchor.content,
      anchor.context_prefix,
      anchor.token_estimate,
      anchor.parent_content,
      anchor.parent_context_prefix,
      anchor.sort_date,
      anchor.document_rank,
      anchor.diversity_bucket,
      anchor.document_ordinal,
      anchor.chunk_id as anchor_chunk_id,
      0 as neighbour_offset,
      anchor.score as expanded_score
    from anchors anchor
    union all
    select
      neighbour.chunk_id,
      neighbour.document_id,
      neighbour.parent_chunk_id,
      neighbour.title,
      neighbour.document_metadata,
      neighbour.chunk_index,
      neighbour.heading,
      neighbour.path,
      neighbour.page_number,
      neighbour.content,
      neighbour.context_prefix,
      neighbour.token_estimate,
      neighbour.parent_content,
      neighbour.parent_context_prefix,
      anchor.sort_date,
      anchor.document_rank,
      anchor.diversity_bucket,
      anchor.document_ordinal,
      anchor.chunk_id as anchor_chunk_id,
      neighbour.chunk_index - anchor.chunk_index as neighbour_offset,
      greatest(0.0001, anchor.score * 0.62)::real as expanded_score
    from anchors anchor
    join scored neighbour
      on neighbour.document_id = anchor.document_id
     and neighbour.parent_chunk_id = anchor.parent_chunk_id
     and neighbour.chunk_index in (
       anchor.chunk_index - 1,
       anchor.chunk_index + 1
     )
  ),
  deduped as (
    select distinct on (chunk_id)
      expanded.*
    from expanded
    order by
      chunk_id,
      (neighbour_offset = 0) desc,
      expanded_score desc,
      abs(neighbour_offset)
  ),
  selected_counts as (
    select
      document_id,
      count(distinct parent_chunk_id)::integer as selected_parent_count
    from anchors
    group by document_id
  ),
  output_ranked as (
    select
      deduped.*,
      selected_counts.selected_parent_count,
      available_counts.available_parent_count,
      row_number() over (
        partition by deduped.document_id
        order by
          case when deduped.neighbour_offset = 0 then 0 else 1 end,
          deduped.expanded_score desc,
          deduped.chunk_index
      ) as document_output_rank,
      dense_rank() over (
        order by
          case when v_mode = 'timeline' then deduped.sort_date end asc nulls last,
          deduped.document_id,
          deduped.chunk_index
      ) as timeline_output_rank
    from deduped
    join selected_counts using (document_id)
    join available_counts using (document_id)
  ),
  final_rows as (
    select
      output_ranked.*,
      case
        when v_mode = 'timeline' then
          greatest(0.0001, 1000.0 - timeline_output_rank::real)
        when v_mode = 'comparison' then
          greatest(
            0.0001,
            1000.0
              - document_rank::real * 10.0
              - document_ordinal::real / 100.0
              - abs(neighbour_offset)::real * 100.0
          )
        when v_mode in ('summary', 'exhaustive') then
          greatest(
            0.0001,
            1000.0
              - diversity_bucket::real * 2.0
              - abs(neighbour_offset)::real * 100.0
          )
        else greatest(0.0001, expanded_score)
      end::real as output_score
    from output_ranked
  )
  select
    final_rows.chunk_id,
    final_rows.document_id,
    final_rows.parent_chunk_id,
    final_rows.title,
    final_rows.chunk_index,
    final_rows.heading,
    final_rows.path,
    final_rows.page_number,
    final_rows.content,
    final_rows.context_prefix,
    final_rows.token_estimate,
    case
      when final_rows.document_output_rank = 1 and v_mode <> 'pinpoint' then
        concat_ws(
          E'\n\n',
          public.source_document_map_text(
            final_rows.document_metadata,
            final_rows.title,
            v_mode,
            final_rows.selected_parent_count,
            final_rows.available_parent_count
          ),
          final_rows.parent_content
        )
      else final_rows.parent_content
    end as parent_content,
    final_rows.parent_context_prefix,
    final_rows.output_score as lexical_rank
  from final_rows
  order by
    final_rows.output_score desc,
    final_rows.document_id,
    final_rows.chunk_index
  limit v_limit;
end;
$$;

-- Build deterministic maps for already-indexed documents. New documents are
-- handled by the ready-state trigger above.
do $$
declare
  v_document record;
begin
  for v_document in
    select document.id, document.owner_user_id
    from public.source_documents document
    where document.status = 'ready'
      and coalesce(document.metadata ->> 'document_map_version', '') <> '1'
    order by document.created_at
  loop
    perform public.refresh_source_document_map(
      v_document.id,
      v_document.owner_user_id
    );
  end loop;
end;
$$;

revoke all on function public.source_infer_retrieval_mode(text, integer) from public, anon;
revoke all on function public.source_expand_query_terms(uuid, uuid[], text) from public, anon;
revoke all on function public.source_build_expanded_tsquery(uuid, uuid[], text) from public, anon;
revoke all on function public.source_exact_phrase_boost(text, text) from public, anon;
revoke all on function public.source_special_term_boost(text, text) from public, anon;
revoke all on function public.source_extract_sort_date(text) from public, anon;
revoke all on function public.refresh_source_document_map(uuid, uuid) from public, anon;
revoke all on function public.source_document_map_text(jsonb, text, text, integer, integer) from public, anon;
revoke all on function public.search_source_chunks(uuid, uuid[], text, integer) from public, anon;

grant execute on function public.source_infer_retrieval_mode(text, integer) to authenticated, service_role;
grant execute on function public.source_expand_query_terms(uuid, uuid[], text) to authenticated, service_role;
grant execute on function public.source_build_expanded_tsquery(uuid, uuid[], text) to authenticated, service_role;
grant execute on function public.source_exact_phrase_boost(text, text) to authenticated, service_role;
grant execute on function public.source_special_term_boost(text, text) to authenticated, service_role;
grant execute on function public.source_extract_sort_date(text) to authenticated, service_role;
grant execute on function public.refresh_source_document_map(uuid, uuid) to authenticated, service_role;
grant execute on function public.source_document_map_text(jsonb, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.search_source_chunks(uuid, uuid[], text, integer) to authenticated, service_role;

comment on column public.source_chunks.fts_weighted is
  'Weighted FTS vector: heading A, path/context B, content D.';
comment on function public.search_source_chunks(uuid, uuid[], text, integer) is
  'Phase 5 field-aware FTS with deterministic expansion, neighbours, mode quotas, and document maps.';
