-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- PostgreSQL exposes RETURNS TABLE output names as PL/pgSQL variables. The
-- Phase 5 search RPC originally reused names such as document_id, chunk_index,
-- and parent_chunk_id inside CTEs without aliases, which can raise SQLSTATE
-- 42702 at execution time. This replacement qualifies every CTE reference and
-- replaces USING joins with explicit ON clauses while retaining the public RPC
-- signature and retrieval behaviour.

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
  with base_rows as (
    select
      child_chunk.id as chunk_id,
      child_chunk.document_id as document_id,
      child_chunk.parent_chunk_id as parent_chunk_id,
      source_document.title as title,
      source_document.metadata as document_metadata,
      child_chunk.chunk_index as chunk_index,
      child_chunk.heading as heading,
      child_chunk.path as path,
      child_chunk.page_number as page_number,
      child_chunk.content as content,
      child_chunk.context_prefix as context_prefix,
      child_chunk.token_estimate as token_estimate,
      child_chunk.fts_weighted as fts_weighted,
      parent_chunk.content as parent_content,
      parent_chunk.context_prefix as parent_context_prefix,
      min(child_chunk.chunk_index) over (
        partition by child_chunk.parent_chunk_id
      ) as first_child_index,
      max(child_chunk.chunk_index) over (
        partition by child_chunk.parent_chunk_id
      ) as last_child_index,
      public.source_extract_sort_date(child_chunk.content) as sort_date
    from public.source_chunks as child_chunk
    join public.source_chunks as parent_chunk
      on parent_chunk.id = child_chunk.parent_chunk_id
     and parent_chunk.document_id = child_chunk.document_id
     and parent_chunk.chunk_role = 'parent'
    join public.source_documents as source_document
      on source_document.id = child_chunk.document_id
     and source_document.owner_user_id = child_chunk.owner_user_id
    where child_chunk.owner_user_id = p_owner_user_id
      and child_chunk.document_id = any(
        coalesce(p_document_ids, array[]::uuid[])
      )
      and child_chunk.chunk_role = 'child'
      and source_document.status = 'ready'
  ),
  available_counts as (
    select
      base_row.document_id as document_id,
      count(distinct base_row.parent_chunk_id)::integer
        as available_parent_count
    from base_rows as base_row
    group by base_row.document_id
  ),
  scored_rows as (
    select
      base_row.*,
      (
        case
          when numnode(v_original_query) > 0 then
            ts_rank_cd(base_row.fts_weighted, v_original_query) * 4.0
          else 0
        end
        + case
            when numnode(v_expanded_query) > 0 then
              ts_rank_cd(base_row.fts_weighted, v_expanded_query) * 1.35
            else 0
          end
        + case
            when numnode(v_original_query) > 0 then
              ts_rank_cd(
                to_tsvector('simple', coalesce(base_row.title, '')),
                v_original_query
              ) * 1.75
            else 0
          end
        + public.source_exact_phrase_boost(
            concat_ws(
              ' ',
              base_row.title,
              base_row.heading,
              base_row.path,
              base_row.content
            ),
            p_query
          )
        + public.source_special_term_boost(
            concat_ws(
              ' ',
              base_row.title,
              base_row.heading,
              base_row.path,
              base_row.content
            ),
            p_query
          )
        + case
            when v_mode = 'section'
              and numnode(v_expanded_query) > 0
              and to_tsvector(
                'simple',
                concat_ws(
                  ' ',
                  base_row.heading,
                  base_row.path,
                  base_row.context_prefix
                )
              ) @@ v_expanded_query
              then 2.0
            else 0
          end
        + case when base_row.heading is not null then 0.05 else 0 end
      )::real as score,
      (
        (
          numnode(v_original_query) > 0
          and base_row.fts_weighted @@ v_original_query
        )
        or (
          numnode(v_expanded_query) > 0
          and base_row.fts_weighted @@ v_expanded_query
        )
      ) as lexical_match,
      (
        (
          numnode(v_original_query) > 0
          and to_tsvector(
            'simple',
            concat_ws(
              ' ',
              base_row.heading,
              base_row.path,
              base_row.context_prefix
            )
          ) @@ v_original_query
        )
        or (
          numnode(v_expanded_query) > 0
          and to_tsvector(
            'simple',
            concat_ws(
              ' ',
              base_row.heading,
              base_row.path,
              base_row.context_prefix
            )
          ) @@ v_expanded_query
        )
      ) as section_match
    from base_rows as base_row
  ),
  eligible_rows as (
    select scored_row.*
    from scored_rows as scored_row
    where case v_mode
      when 'summary' then
        scored_row.chunk_index in (
          scored_row.first_child_index,
          scored_row.last_child_index
        )
      when 'comparison' then
        scored_row.lexical_match
        or scored_row.chunk_index = scored_row.first_child_index
      when 'timeline' then
        scored_row.sort_date is not null
      when 'exhaustive' then
        scored_row.chunk_index = scored_row.first_child_index
      when 'section' then
        scored_row.section_match
        or (
          scored_row.lexical_match
          and not exists (
            select 1
            from scored_rows as section_candidate
            where section_candidate.section_match
          )
        )
      else scored_row.lexical_match
    end
  ),
  ranked_rows as (
    select
      eligible_row.*,
      row_number() over (
        partition by
          eligible_row.document_id,
          eligible_row.parent_chunk_id
        order by eligible_row.score desc, eligible_row.chunk_index
      ) as parent_rank,
      row_number() over (
        partition by eligible_row.document_id
        order by
          eligible_row.score desc,
          coalesce(eligible_row.page_number, 2147483647),
          eligible_row.chunk_index
      ) as document_rank,
      row_number() over (
        partition by eligible_row.document_id, eligible_row.page_number
        order by eligible_row.score desc, eligible_row.chunk_index
      ) as page_rank,
      ntile(v_per_document) over (
        partition by eligible_row.document_id
        order by
          coalesce(eligible_row.page_number, 2147483647),
          eligible_row.chunk_index
      ) as diversity_bucket,
      dense_rank() over (
        order by eligible_row.document_id
      ) as document_ordinal
    from eligible_rows as eligible_row
  ),
  bucketed_rows as (
    select
      ranked_row.*,
      row_number() over (
        partition by
          ranked_row.document_id,
          ranked_row.diversity_bucket
        order by
          ranked_row.score desc,
          coalesce(ranked_row.page_number, 2147483647),
          ranked_row.chunk_index
      ) as bucket_rank
    from ranked_rows as ranked_row
  ),
  anchor_candidate_rows as (
    select bucketed_row.*
    from bucketed_rows as bucketed_row
    where case v_mode
      when 'summary' then
        bucketed_row.bucket_rank = 1
        and bucketed_row.parent_rank = 1
      when 'exhaustive' then
        bucketed_row.bucket_rank = 1
        and bucketed_row.parent_rank = 1
      when 'comparison' then
        bucketed_row.document_rank <= v_per_document
        and bucketed_row.parent_rank <= 2
        and bucketed_row.page_rank <= 2
      when 'timeline' then
        bucketed_row.parent_rank = 1
        and bucketed_row.page_rank <= 2
      when 'section' then
        bucketed_row.parent_rank <= 3
        and bucketed_row.page_rank <= 2
      else
        bucketed_row.parent_rank <= 2
        and bucketed_row.page_rank <= 2
    end
  ),
  anchor_rows as (
    select anchor_candidate_row.*
    from anchor_candidate_rows as anchor_candidate_row
    order by
      case
        when v_mode = 'timeline' then anchor_candidate_row.sort_date
      end asc nulls last,
      case
        when v_mode in ('summary', 'exhaustive') then
          anchor_candidate_row.diversity_bucket
      end asc nulls last,
      case
        when v_mode = 'comparison' then anchor_candidate_row.document_rank
      end asc nulls last,
      anchor_candidate_row.score desc,
      anchor_candidate_row.document_id,
      anchor_candidate_row.chunk_index
    limit v_limit
  ),
  expanded_rows as (
    select
      anchor_row.chunk_id,
      anchor_row.document_id,
      anchor_row.parent_chunk_id,
      anchor_row.title,
      anchor_row.document_metadata,
      anchor_row.chunk_index,
      anchor_row.heading,
      anchor_row.path,
      anchor_row.page_number,
      anchor_row.content,
      anchor_row.context_prefix,
      anchor_row.token_estimate,
      anchor_row.parent_content,
      anchor_row.parent_context_prefix,
      anchor_row.sort_date,
      anchor_row.document_rank,
      anchor_row.diversity_bucket,
      anchor_row.document_ordinal,
      anchor_row.chunk_id as anchor_chunk_id,
      0 as neighbour_offset,
      anchor_row.score as expanded_score
    from anchor_rows as anchor_row

    union all

    select
      neighbour_row.chunk_id,
      neighbour_row.document_id,
      neighbour_row.parent_chunk_id,
      neighbour_row.title,
      neighbour_row.document_metadata,
      neighbour_row.chunk_index,
      neighbour_row.heading,
      neighbour_row.path,
      neighbour_row.page_number,
      neighbour_row.content,
      neighbour_row.context_prefix,
      neighbour_row.token_estimate,
      neighbour_row.parent_content,
      neighbour_row.parent_context_prefix,
      anchor_row.sort_date,
      anchor_row.document_rank,
      anchor_row.diversity_bucket,
      anchor_row.document_ordinal,
      anchor_row.chunk_id as anchor_chunk_id,
      neighbour_row.chunk_index - anchor_row.chunk_index as neighbour_offset,
      greatest(0.0001, anchor_row.score * 0.62)::real as expanded_score
    from anchor_rows as anchor_row
    join scored_rows as neighbour_row
      on neighbour_row.document_id = anchor_row.document_id
     and neighbour_row.parent_chunk_id = anchor_row.parent_chunk_id
     and neighbour_row.chunk_index in (
       anchor_row.chunk_index - 1,
       anchor_row.chunk_index + 1
     )
  ),
  deduped_rows as (
    select distinct on (expanded_row.chunk_id)
      expanded_row.*
    from expanded_rows as expanded_row
    order by
      expanded_row.chunk_id,
      (expanded_row.neighbour_offset = 0) desc,
      expanded_row.expanded_score desc,
      abs(expanded_row.neighbour_offset)
  ),
  selected_counts as (
    select
      anchor_row.document_id as document_id,
      count(distinct anchor_row.parent_chunk_id)::integer
        as selected_parent_count
    from anchor_rows as anchor_row
    group by anchor_row.document_id
  ),
  output_ranked_rows as (
    select
      deduped_row.*,
      selected_count.selected_parent_count,
      available_count.available_parent_count,
      row_number() over (
        partition by deduped_row.document_id
        order by
          case when deduped_row.neighbour_offset = 0 then 0 else 1 end,
          deduped_row.expanded_score desc,
          deduped_row.chunk_index
      ) as document_output_rank,
      dense_rank() over (
        order by
          case
            when v_mode = 'timeline' then deduped_row.sort_date
          end asc nulls last,
          deduped_row.document_id,
          deduped_row.chunk_index
      ) as timeline_output_rank
    from deduped_rows as deduped_row
    join selected_counts as selected_count
      on selected_count.document_id = deduped_row.document_id
    join available_counts as available_count
      on available_count.document_id = deduped_row.document_id
  ),
  final_rows as (
    select
      output_ranked_row.*,
      case
        when v_mode = 'timeline' then
          greatest(
            0.0001,
            1000.0 - output_ranked_row.timeline_output_rank::real
          )
        when v_mode = 'comparison' then
          greatest(
            0.0001,
            1000.0
              - output_ranked_row.document_rank::real * 10.0
              - output_ranked_row.document_ordinal::real / 100.0
              - abs(output_ranked_row.neighbour_offset)::real * 100.0
          )
        when v_mode in ('summary', 'exhaustive') then
          greatest(
            0.0001,
            1000.0
              - output_ranked_row.diversity_bucket::real * 2.0
              - abs(output_ranked_row.neighbour_offset)::real * 100.0
          )
        else greatest(0.0001, output_ranked_row.expanded_score)
      end::real as output_score
    from output_ranked_rows as output_ranked_row
  )
  select
    final_row.chunk_id,
    final_row.document_id,
    final_row.parent_chunk_id,
    final_row.title,
    final_row.chunk_index,
    final_row.heading,
    final_row.path,
    final_row.page_number,
    final_row.content,
    final_row.context_prefix,
    final_row.token_estimate,
    case
      when final_row.document_output_rank = 1
        and v_mode <> 'pinpoint' then
        concat_ws(
          E'\n\n',
          public.source_document_map_text(
            final_row.document_metadata,
            final_row.title,
            v_mode,
            final_row.selected_parent_count,
            final_row.available_parent_count
          ),
          final_row.parent_content
        )
      else final_row.parent_content
    end as parent_content,
    final_row.parent_context_prefix,
    final_row.output_score as lexical_rank
  from final_rows as final_row
  order by
    final_row.output_score desc,
    final_row.document_id,
    final_row.chunk_index
  limit v_limit;
end;
$$;

revoke all on function public.search_source_chunks(uuid, uuid[], text, integer)
  from public, anon;

grant execute on function public.search_source_chunks(uuid, uuid[], text, integer)
  to authenticated, service_role;

comment on function public.search_source_chunks(uuid, uuid[], text, integer) is
  'Phase 5 field-aware FTS with fully qualified CTEs, deterministic expansion, neighbours, mode quotas, and document maps.';
