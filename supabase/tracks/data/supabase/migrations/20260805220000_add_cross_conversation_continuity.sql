-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Phase 6: searchable cross-conversation continuity without another model or
-- embedding call. Existing conversation capsules become individually searchable
-- project capsules; stable-user and unresolved-work records are selected from
-- active lifecycle-aware memories; exact prior claims remain backed by source
-- messages only.

alter table public.context_capsules
  add column if not exists project_key text,
  add column if not exists entity_keys text[] not null default array[]::text[];

create or replace function public.normalize_continuity_key(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
    trim(both '-' from regexp_replace(
      lower(regexp_replace(btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g')),
      '[^[:alnum:]_-]+',
      '-',
      'g'
    )),
    ''
  );
$$;

create or replace function public.infer_context_capsule_project_key(
  p_title text,
  p_content text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_title text := regexp_replace(btrim(coalesce(p_title, '')), '[[:space:]]+', ' ', 'g');
  v_content text := regexp_replace(btrim(coalesce(p_content, '')), '[[:space:]]+', ' ', 'g');
  v_match text[];
  v_candidate text;
begin
  v_match := regexp_match(
    v_title || ' ' || left(v_content, 1200),
    '\mproject[[:space:]]+(?:(?:called|named)[[:space:]]+)?["“]?([[:alnum:]_][[:alnum:]_.-]*(?:[[:space:]]+[[:alnum:]_][[:alnum:]_.-]*){0,2})["”]?\M',
    'i'
  );

  if v_match is not null and btrim(coalesce(v_match[1], '')) <> '' then
    v_candidate := regexp_replace(
      btrim(v_match[1]),
      '[[:space:]]+(?:now|currently|today|work|system|project)$',
      '',
      'i'
    );
  elsif v_title <> '' then
    v_candidate := regexp_replace(
      v_title,
      '\m(?:chat|conversation|discussion|new chat|untitled|audit|review|status|update|updates|work|working|continue|continuation)\M',
      ' ',
      'gi'
    );
    v_candidate := regexp_replace(v_candidate, '[[:space:]]+', ' ', 'g');
    v_candidate := btrim(v_candidate);
  end if;

  if v_candidate is null or length(v_candidate) < 2 then
    return null;
  end if;

  return left(public.normalize_continuity_key(v_candidate), 120);
end;
$$;

create or replace function public.extract_context_capsule_entity_keys(
  p_title text,
  p_content text,
  p_project_key text default null
)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  with tokens as (
    select lower(token) as token
    from regexp_split_to_table(
      coalesce(p_title, '') || ' ' || coalesce(p_project_key, '') || ' ' || left(coalesce(p_content, ''), 1600),
      '[^[:alnum:]_-]+'
    ) as split(token)
    where length(token) >= 3
      and lower(token) not in (
        'the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'when',
        'where', 'about', 'your', 'user', 'assistant', 'chat', 'conversation',
        'project', 'system', 'work', 'working', 'continue', 'continued', 'status',
        'update', 'updates', 'current', 'currently', 'next', 'step', 'plan'
      )
  )
  select coalesce(array_agg(token order by token), array[]::text[])
  from (
    select distinct token
    from tokens
    limit 24
  ) as unique_tokens;
$$;

create or replace function public.prepare_context_capsule_continuity_row()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_title text;
begin
  if new.scope <> 'conversation' or new.conversation_id is null then
    new.project_key := null;
    new.entity_keys := array[]::text[];
    return new;
  end if;

  select conversation.title
  into v_title
  from public.conversations as conversation
  where conversation.id = new.conversation_id
    and conversation.user_id = new.owner_user_id;

  new.project_key := public.infer_context_capsule_project_key(v_title, new.content);
  new.entity_keys := public.extract_context_capsule_entity_keys(
    v_title,
    new.content,
    new.project_key
  );
  return new;
end;
$$;

drop trigger if exists prepare_context_capsule_continuity_row_trigger
  on public.context_capsules;
create trigger prepare_context_capsule_continuity_row_trigger
before insert or update of owner_user_id, scope, conversation_id, content
on public.context_capsules
for each row
execute function public.prepare_context_capsule_continuity_row();

-- Backfill deterministic metadata for existing conversation capsules. The
-- trigger performs all derivation locally and does not call a provider.
update public.context_capsules as capsule
set content = capsule.content
where capsule.scope = 'conversation';

alter table public.context_capsules
  add column if not exists continuity_search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(project_key, '')), 'A') ||
    setweight(to_tsvector('simple', array_to_string(coalesce(entity_keys, array[]::text[]), ' ')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored;

create index if not exists context_capsules_continuity_search_gin_idx
  on public.context_capsules using gin(continuity_search_vector)
  where scope = 'conversation';

create index if not exists conversations_title_continuity_fts_idx
  on public.conversations using gin(to_tsvector('english', coalesce(title, '')));

create index if not exists messages_continuity_fts_idx
  on public.messages using gin(to_tsvector('english', coalesce(content, '')))
  where role in ('user', 'assistant');

create index if not exists context_capsules_owner_project_idx
  on public.context_capsules(owner_user_id, project_key, updated_at desc, id desc)
  where scope = 'conversation';

create or replace function public.search_cross_conversation_context(
  p_owner_user_id uuid,
  p_query text,
  p_current_conversation_id uuid default null,
  p_project_limit integer default 3,
  p_source_limit integer default 6,
  p_assistant_excerpt_chars integer default 700
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with parameters as (
    select
      lower(regexp_replace(btrim(coalesce(p_query, '')), '[[:space:]]+', ' ', 'g')) as normalized_query,
      websearch_to_tsquery('english', coalesce(p_query, '')) as ts_query,
      greatest(1, least(coalesce(p_project_limit, 3), 3)) as project_limit,
      greatest(0, least(coalesce(p_source_limit, 6), 12)) as source_limit,
      greatest(160, least(coalesce(p_assistant_excerpt_chars, 700), 900)) as assistant_excerpt_chars
  ),
  owned_conversations as (
    select conversation.id, conversation.title, conversation.created_at
    from public.conversations as conversation
    where conversation.user_id = p_owner_user_id
      and conversation.id is distinct from p_current_conversation_id
  ),
  capsule_scored as (
    select
      capsule.id,
      capsule.conversation_id,
      conversation.title,
      capsule.content,
      capsule.project_key,
      capsule.entity_keys,
      capsule.version,
      capsule.updated_at,
      (
        length(parameters.normalized_query) between 3 and 180
        and (
          position(parameters.normalized_query in lower(coalesce(conversation.title, ''))) > 0
          or position(parameters.normalized_query in lower(capsule.content)) > 0
        )
      ) as exact_phrase_match,
      exists (
        select 1
        from unnest(capsule.entity_keys) as entity(key)
        where length(entity.key) >= 3
          and position(entity.key in parameters.normalized_query) > 0
      ) as entity_match,
      case
        when numnode(parameters.ts_query) = 0 then 0::real
        else (
          ts_rank_cd(to_tsvector('english', coalesce(conversation.title, '')), parameters.ts_query, 32) * 1.8
          + ts_rank_cd(capsule.continuity_search_vector, parameters.ts_query, 32)
        )::real
      end as lexical_rank,
      (1.0 / (1.0 + greatest(0, extract(epoch from (now() - capsule.updated_at)) / 86400.0) / 120.0))::real
        as recency_rank
    from public.context_capsules as capsule
    join owned_conversations as conversation
      on conversation.id = capsule.conversation_id
    cross join parameters
    where capsule.owner_user_id = p_owner_user_id
      and capsule.scope = 'conversation'
  ),
  capsule_eligible as (
    select
      scored.*,
      (
        case when scored.exact_phrase_match then 100 else 0 end
        + case when scored.entity_match then 35 else 0 end
        + scored.lexical_rank * 30
        + scored.recency_rank * 3
      )::real as retrieval_rank
    from capsule_scored as scored
    where scored.exact_phrase_match
      or scored.entity_match
      or scored.lexical_rank > 0
  ),
  selected_capsules as (
    select eligible.*
    from capsule_eligible as eligible
    order by
      eligible.exact_phrase_match desc,
      eligible.entity_match desc,
      eligible.lexical_rank desc,
      eligible.recency_rank desc,
      eligible.updated_at desc,
      eligible.id desc
    limit (select project_limit from parameters)
  ),
  project_capsule_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'capsule_id', capsule.id,
          'conversation_id', capsule.conversation_id,
          'conversation_title', capsule.title,
          'content', capsule.content,
          'project_key', capsule.project_key,
          'entity_keys', to_jsonb(capsule.entity_keys),
          'version', capsule.version,
          'updated_at', capsule.updated_at,
          'retrieval_rank', capsule.retrieval_rank,
          'provenance_kind', 'capsule',
          'supports_exact_claim', false
        )
        order by capsule.retrieval_rank desc, capsule.updated_at desc, capsule.id desc
      ),
      '[]'::jsonb
    ) as value
    from selected_capsules as capsule
  ),
  stable_memory_rows as (
    select memory.*
    from public.memories as memory
    where memory.user_id = p_owner_user_id
      and memory.status = 'active'
      and memory.fact_type in ('stable_identity', 'stable_preference')
    order by memory.importance desc, memory.last_confirmed_at desc, memory.id desc
    limit 12
  ),
  stable_user_payload as (
    select jsonb_build_object(
      'provenance_kind', 'memory',
      'supports_saved_fact', true,
      'supports_exact_claim', false,
      'facts', coalesce(
        jsonb_agg(
          jsonb_build_object(
            'memory_id', memory.id,
            'summary', memory.summary,
            'fact_type', memory.fact_type,
            'subject_key', memory.subject_key,
            'importance', memory.importance,
            'confidence', memory.confidence,
            'last_confirmed_at', memory.last_confirmed_at
          )
          order by memory.importance desc, memory.last_confirmed_at desc, memory.id desc
        ),
        '[]'::jsonb
      )
    ) as value
    from stable_memory_rows as memory
  ),
  unresolved_scored as (
    select
      memory.*,
      case
        when numnode(parameters.ts_query) = 0 then 0::real
        else ts_rank_cd(memory.search_vector, parameters.ts_query, 32)::real
      end as lexical_rank,
      exists (
        select 1
        from selected_capsules as capsule
        where capsule.project_key is not null
          and public.normalize_continuity_key(memory.project_scope) = capsule.project_key
      ) as selected_project_match
    from public.memories as memory
    cross join parameters
    where memory.user_id = p_owner_user_id
      and memory.status = 'active'
      and memory.fact_type = 'unresolved_commitment'
  ),
  unresolved_rows as (
    select unresolved.*
    from unresolved_scored as unresolved
    where unresolved.lexical_rank > 0
      or unresolved.selected_project_match
      or unresolved.importance >= 8
    order by
      unresolved.selected_project_match desc,
      unresolved.lexical_rank desc,
      unresolved.importance desc,
      unresolved.last_confirmed_at desc,
      unresolved.id desc
    limit 8
  ),
  unresolved_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'memory_id', memory.id,
          'summary', memory.summary,
          'subject_key', memory.subject_key,
          'project_scope', memory.project_scope,
          'temporal_scope', memory.temporal_scope,
          'importance', memory.importance,
          'confidence', memory.confidence,
          'last_confirmed_at', memory.last_confirmed_at,
          'provenance_kind', 'memory',
          'supports_saved_fact', true,
          'supports_exact_claim', false
        )
        order by
          memory.selected_project_match desc,
          memory.lexical_rank desc,
          memory.importance desc,
          memory.last_confirmed_at desc,
          memory.id desc
      ),
      '[]'::jsonb
    ) as value
    from unresolved_rows as memory
  ),
  message_scored as (
    select
      message.id,
      message.conversation_id,
      conversation.title,
      message.role,
      message.content,
      message.created_at,
      case
        when numnode(parameters.ts_query) = 0 then 0::real
        else ts_rank_cd(to_tsvector('english', coalesce(message.content, '')), parameters.ts_query, 32)::real
      end as lexical_rank,
      exists (
        select 1
        from selected_capsules as capsule
        where capsule.conversation_id = message.conversation_id
      ) as selected_conversation
    from public.messages as message
    join owned_conversations as conversation
      on conversation.id = message.conversation_id
    cross join parameters
    where message.role = 'user'
       or (
         message.role = 'assistant'
         and message.content ~* '\m(decid(?:e|ed|ing)|decision|recommend(?:ed|ation)?|conclud(?:e|ed)|conclusion|agreed|next[[:space:]]+step|plan(?:ned)?|implement(?:ed)?|fix(?:ed)?|resolv(?:e|ed)|complet(?:e|ed)|ready|should|must)\M'
       )
  ),
  message_eligible as (
    select scored.*
    from message_scored as scored
    where scored.lexical_rank > 0
       or (
         scored.selected_conversation
         and exists (
           select 1
           from regexp_split_to_table(
             lower(regexp_replace(coalesce(p_query, ''), '[^[:alnum:]_]+', ' ', 'g')),
             '[[:space:]]+'
           ) as query_token(token)
           where length(query_token.token) >= 4
             and position(query_token.token in lower(scored.content)) > 0
         )
       )
  ),
  selected_messages as (
    select eligible.*
    from message_eligible as eligible
    order by
      eligible.lexical_rank desc,
      eligible.selected_conversation desc,
      eligible.created_at desc,
      eligible.id desc
    limit (select source_limit from parameters)
  ),
  source_evidence_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'message_id', message.id,
          'conversation_id', message.conversation_id,
          'conversation_title', message.title,
          'role', message.role,
          'content', left(message.content, parameters.assistant_excerpt_chars),
          'content_truncated', length(message.content) > parameters.assistant_excerpt_chars,
          'created_at', message.created_at,
          'lexical_rank', message.lexical_rank,
          'provenance_kind', 'source_message',
          'supports_exact_claim', true
        )
        order by message.lexical_rank desc, message.created_at desc, message.id desc
      ),
      '[]'::jsonb
    ) as value
    from selected_messages as message
    cross join parameters
  )
  select jsonb_build_object(
    'schema_version', 1,
    'query', coalesce(p_query, ''),
    'stable_user_capsule', stable_user_payload.value,
    'project_capsules', project_capsule_payload.value,
    'unresolved_work', unresolved_payload.value,
    'source_evidence', source_evidence_payload.value,
    'provenance_contract', jsonb_build_object(
      'memory', 'saved fact only',
      'capsule', 'broad continuity only',
      'source_message', 'exact prior claim permitted only when excerpt supports it'
    )
  )
  from stable_user_payload
  cross join project_capsule_payload
  cross join unresolved_payload
  cross join source_evidence_payload;
$$;

revoke all on function public.normalize_continuity_key(text) from public, anon;
revoke all on function public.infer_context_capsule_project_key(text, text) from public, anon;
revoke all on function public.extract_context_capsule_entity_keys(text, text, text) from public, anon;
revoke all on function public.prepare_context_capsule_continuity_row() from public, anon;
revoke all on function public.search_cross_conversation_context(uuid, text, uuid, integer, integer, integer)
  from public, anon;

grant execute on function public.normalize_continuity_key(text)
  to authenticated, service_role;
grant execute on function public.infer_context_capsule_project_key(text, text)
  to authenticated, service_role;
grant execute on function public.extract_context_capsule_entity_keys(text, text, text)
  to authenticated, service_role;
grant execute on function public.prepare_context_capsule_continuity_row()
  to authenticated, service_role;
grant execute on function public.search_cross_conversation_context(uuid, text, uuid, integer, integer, integer)
  to authenticated, service_role;

comment on function public.search_cross_conversation_context(uuid, text, uuid, integer, integer, integer) is
  'Selects stable saved facts, one to three relevant project capsules, unresolved work, and bounded source-message evidence across the full owned conversation collection without embeddings or provider calls.';

create or replace function public.get_cross_conversation_continuity_schema_version()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select '20260805220000'::text;
$$;

revoke all on function public.get_cross_conversation_continuity_schema_version()
  from public, anon, authenticated;
grant execute on function public.get_cross_conversation_continuity_schema_version()
  to service_role;
