-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Phase 3: full-collection lexical memory retrieval, deterministic lifecycle
-- metadata, and conflict-aware supersession. This migration does not generate
-- embeddings and does not add any provider/model call.

create or replace function public.normalize_memory_subject_key(
  p_type text,
  p_summary text,
  p_project_scope text default null
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_type text := lower(btrim(coalesce(p_type, 'project')));
  v_summary text := lower(regexp_replace(btrim(coalesce(p_summary, '')), '[[:space:]]+', ' ', 'g'));
  v_project text := lower(regexp_replace(btrim(coalesce(p_project_scope, '')), '[^[:alnum:]_-]+', '-', 'g'));
begin
  if v_type = 'preference' then
    if v_summary ~ '\m(concise|brief|short|detailed|verbose|long|length|wordy)\M' then
      return 'preference:response_length';
    elsif v_summary ~ '\m(formal|casual|friendly|professional|tone)\M' then
      return 'preference:response_tone';
    elsif v_summary ~ '\m(dark|light|theme|appearance)\M' then
      return 'preference:appearance';
    elsif v_summary ~ '\m(language|english|bengali|hindi|bangla)\M' then
      return 'preference:language';
    elsif v_summary ~ '\m(bullet|bullets|list|paragraph|format)\M' then
      return 'preference:response_format';
    end if;
  elsif v_type = 'identity' then
    if v_summary ~ '\m(name|called)\M' then return 'identity:name'; end if;
    if v_summary ~ '\m(email|e-mail)\M' then return 'identity:email'; end if;
    if v_summary ~ '\m(phone|mobile|number)\M' then return 'identity:phone'; end if;
    if v_summary ~ '\m(birthday|date of birth|born)\M' then return 'identity:birthday'; end if;
    if v_summary ~ '\m(live|lives|located|location|city|country|address)\M' then return 'identity:location'; end if;
    if v_summary ~ '\m(student|degree|college|university|school|occupation|job|role)\M' then return 'identity:education_or_role'; end if;
  elsif v_type = 'project' and v_project <> '' then
    return 'project:' || left(trim(both '-' from v_project), 96);
  end if;

  return v_type || ':' || left(encode(digest(v_summary, 'sha256'), 'hex'), 32);
end;
$$;

create or replace function public.infer_memory_fact_type(
  p_type text,
  p_summary text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_type text := lower(btrim(coalesce(p_type, 'project')));
  v_summary text := lower(regexp_replace(btrim(coalesce(p_summary, '')), '[[:space:]]+', ' ', 'g'));
begin
  if v_type = 'identity' then
    return 'stable_identity';
  elsif v_type = 'preference' then
    return 'stable_preference';
  elsif v_summary ~ '\m(today|tonight|tomorrow|this week|currently|temporarily|for now|right now)\M' then
    return 'temporary_condition';
  elsif v_summary ~ '\m(next step|need to|needs to|must|should|will|plan to|todo|to-do|pending|awaiting|waiting|follow up|follow-up|unresolved|deadline)\M' then
    return 'unresolved_commitment';
  end if;
  return 'active_project_state';
end;
$$;

alter table public.memories
  add column if not exists subject_key text,
  add column if not exists source_conversation_id uuid null references public.conversations(id) on delete set null,
  add column if not exists source_message_id uuid null references public.messages(id) on delete set null,
  add column if not exists last_confirmed_at timestamptz,
  add column if not exists supersedes_memory_id uuid null references public.memories(id) on delete set null,
  add column if not exists status text not null default 'active',
  add column if not exists confidence real not null default 0.75,
  add column if not exists fact_type text,
  add column if not exists temporal_scope text,
  add column if not exists project_scope text;

update public.memories as memory
set
  subject_key = coalesce(
    nullif(btrim(memory.subject_key), ''),
    public.normalize_memory_subject_key(memory.type, memory.summary, memory.project_scope)
  ),
  source_conversation_id = coalesce(memory.source_conversation_id, memory.chat_id),
  last_confirmed_at = coalesce(memory.last_confirmed_at, memory.created_at, now()),
  status = case when memory.status in ('active', 'superseded') then memory.status else 'active' end,
  confidence = greatest(0::real, least(1::real, coalesce(memory.confidence, 0.75))),
  fact_type = coalesce(
    nullif(btrim(memory.fact_type), ''),
    public.infer_memory_fact_type(memory.type, memory.summary)
  );

alter table public.memories
  alter column subject_key set not null,
  alter column last_confirmed_at set not null,
  alter column last_confirmed_at set default now(),
  alter column fact_type set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.memories'::regclass
      and conname = 'memories_status_check'
  ) then
    alter table public.memories
      add constraint memories_status_check
      check (status in ('active', 'superseded'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.memories'::regclass
      and conname = 'memories_confidence_check'
  ) then
    alter table public.memories
      add constraint memories_confidence_check
      check (confidence >= 0 and confidence <= 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.memories'::regclass
      and conname = 'memories_fact_type_check'
  ) then
    alter table public.memories
      add constraint memories_fact_type_check
      check (fact_type in (
        'stable_identity',
        'stable_preference',
        'active_project_state',
        'unresolved_commitment',
        'temporary_condition'
      ));
  end if;
end;
$$;

alter table public.memories
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(subject_key, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector(
      'simple',
      coalesce(type, '') || ' ' ||
      coalesce(fact_type, '') || ' ' ||
      coalesce(project_scope, '') || ' ' ||
      coalesce(temporal_scope, '')
    ), 'C')
  ) stored;

create index if not exists memories_search_vector_gin_idx
  on public.memories using gin(search_vector);

create index if not exists memories_active_subject_idx
  on public.memories(user_id, scope, chat_id, subject_key, last_confirmed_at desc, id desc)
  where status = 'active';

create index if not exists memories_active_anchor_idx
  on public.memories(user_id, type, importance desc, last_confirmed_at desc)
  where status = 'active';

-- Deterministically collapse pre-existing conflicts. The newest memory remains
-- active and records the immediately previous conflicting memory it supersedes.
with ordered as (
  select
    memory.id,
    memory.user_id,
    memory.scope,
    memory.chat_id,
    memory.subject_key,
    row_number() over (
      partition by memory.user_id, memory.scope, memory.chat_id, memory.subject_key
      order by memory.last_confirmed_at desc, memory.created_at desc, memory.id desc
    ) as position,
    lead(memory.id) over (
      partition by memory.user_id, memory.scope, memory.chat_id, memory.subject_key
      order by memory.last_confirmed_at desc, memory.created_at desc, memory.id desc
    ) as prior_id
  from public.memories as memory
  where memory.status = 'active'
), superseded as (
  update public.memories as memory
  set status = 'superseded'
  from ordered
  where ordered.id = memory.id
    and ordered.position > 1
  returning memory.id
)
update public.memories as memory
set supersedes_memory_id = ordered.prior_id
from ordered
where ordered.id = memory.id
  and ordered.position = 1
  and ordered.prior_id is not null;

create or replace function public.persist_memory_with_lifecycle(
  p_user_id uuid,
  p_type text,
  p_summary text,
  p_importance integer,
  p_embedding jsonb default null,
  p_embedding_model text default null,
  p_embedding_created_at timestamptz default null,
  p_scope text default 'global',
  p_chat_id uuid default null,
  p_source_conversation_id uuid default null,
  p_source_message_id uuid default null,
  p_subject_key text default null,
  p_fact_type text default null,
  p_confidence real default 0.75,
  p_temporal_scope text default null,
  p_project_scope text default null,
  p_automatic_idempotency_key text default null
)
returns table(
  memory jsonb,
  deduplicated boolean,
  confirmed boolean,
  superseded_memory_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_summary text := regexp_replace(btrim(coalesce(p_summary, '')), '[[:space:]]+', ' ', 'g');
  v_scope text := case when p_scope = 'chat' then 'chat' else 'global' end;
  v_chat_id uuid := case when p_scope = 'chat' then p_chat_id else null end;
  v_subject_key text;
  v_fact_type text;
  v_existing public.memories%rowtype;
  v_previous public.memories%rowtype;
  v_inserted public.memories%rowtype;
begin
  if v_summary = '' then
    raise exception 'Memory summary is required';
  end if;
  if p_type not in ('identity', 'preference', 'project') then
    raise exception 'Invalid memory type';
  end if;
  if p_importance is null or p_importance < 1 or p_importance > 10 then
    raise exception 'Invalid memory importance';
  end if;
  if p_scope not in ('global', 'chat') then
    raise exception 'Invalid memory scope';
  end if;
  if p_automatic_idempotency_key is not null
     and p_automatic_idempotency_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid automatic memory idempotency key';
  end if;
  if v_scope = 'chat' and (
    v_chat_id is null
    or not exists (
      select 1
      from public.conversations as conversation
      where conversation.id = v_chat_id
        and conversation.user_id = p_user_id
    )
  ) then
    raise exception 'Invalid memory conversation';
  end if;
  if p_source_conversation_id is not null and not exists (
    select 1
    from public.conversations as conversation
    where conversation.id = p_source_conversation_id
      and conversation.user_id = p_user_id
  ) then
    raise exception 'Invalid source conversation';
  end if;
  if p_source_message_id is not null and not exists (
    select 1
    from public.messages as message
    join public.conversations as conversation
      on conversation.id = message.conversation_id
    where message.id = p_source_message_id
      and conversation.user_id = p_user_id
  ) then
    raise exception 'Invalid source message';
  end if;

  perform public.ensure_user_exists(p_user_id);
  perform 1 from public.users as app_user where app_user.id = p_user_id for update;

  if p_automatic_idempotency_key is not null then
    select memory_row.*
    into v_existing
    from public.memories as memory_row
    where memory_row.user_id = p_user_id
      and memory_row.automatic_idempotency_key = p_automatic_idempotency_key
    limit 1;

    if found then
      return query select to_jsonb(v_existing), true, false, null::uuid;
      return;
    end if;
  end if;

  v_subject_key := coalesce(
    nullif(btrim(p_subject_key), ''),
    public.normalize_memory_subject_key(p_type, v_summary, p_project_scope)
  );
  v_fact_type := coalesce(
    nullif(btrim(p_fact_type), ''),
    public.infer_memory_fact_type(p_type, v_summary)
  );

  if v_fact_type not in (
    'stable_identity',
    'stable_preference',
    'active_project_state',
    'unresolved_commitment',
    'temporary_condition'
  ) then
    raise exception 'Invalid memory fact type';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_user_id::text || ':' || v_scope || ':' || coalesce(v_chat_id::text, '') || ':' || v_subject_key,
    0
  ));

  select memory_row.*
  into v_existing
  from public.memories as memory_row
  where memory_row.user_id = p_user_id
    and memory_row.scope = v_scope
    and memory_row.chat_id is not distinct from v_chat_id
    and memory_row.subject_key = v_subject_key
    and memory_row.status = 'active'
    and lower(regexp_replace(btrim(memory_row.summary), '[[:space:]]+', ' ', 'g')) = lower(v_summary)
  order by memory_row.last_confirmed_at desc, memory_row.id desc
  limit 1
  for update;

  if found then
    update public.memories as memory_row
    set
      last_confirmed_at = now(),
      confidence = greatest(memory_row.confidence, greatest(0::real, least(1::real, coalesce(p_confidence, 0.75)))),
      importance = greatest(memory_row.importance, p_importance),
      source_conversation_id = coalesce(p_source_conversation_id, memory_row.source_conversation_id),
      source_message_id = coalesce(p_source_message_id, memory_row.source_message_id),
      embedding = coalesce(p_embedding, memory_row.embedding),
      embedding_model = case when p_embedding is not null then p_embedding_model else memory_row.embedding_model end,
      embedding_created_at = case when p_embedding is not null then p_embedding_created_at else memory_row.embedding_created_at end,
      automatic_idempotency_key = coalesce(memory_row.automatic_idempotency_key, p_automatic_idempotency_key),
      temporal_scope = coalesce(p_temporal_scope, memory_row.temporal_scope),
      project_scope = coalesce(p_project_scope, memory_row.project_scope)
    where memory_row.id = v_existing.id
    returning memory_row.* into v_existing;

    return query select to_jsonb(v_existing), true, true, null::uuid;
    return;
  end if;

  select memory_row.*
  into v_previous
  from public.memories as memory_row
  where memory_row.user_id = p_user_id
    and memory_row.scope = v_scope
    and memory_row.chat_id is not distinct from v_chat_id
    and memory_row.subject_key = v_subject_key
    and memory_row.status = 'active'
  order by memory_row.last_confirmed_at desc, memory_row.created_at desc, memory_row.id desc
  limit 1
  for update;

  if found then
    update public.memories as memory_row
    set status = 'superseded'
    where memory_row.id = v_previous.id;
  end if;

  insert into public.memories (
    user_id,
    type,
    summary,
    importance,
    embedding,
    embedding_model,
    embedding_created_at,
    scope,
    chat_id,
    automatic_idempotency_key,
    subject_key,
    source_conversation_id,
    source_message_id,
    last_confirmed_at,
    supersedes_memory_id,
    status,
    confidence,
    fact_type,
    temporal_scope,
    project_scope
  ) values (
    p_user_id,
    p_type,
    v_summary,
    p_importance,
    p_embedding,
    p_embedding_model,
    p_embedding_created_at,
    v_scope,
    v_chat_id,
    p_automatic_idempotency_key,
    v_subject_key,
    coalesce(p_source_conversation_id, v_chat_id),
    p_source_message_id,
    now(),
    case when v_previous.id is not null then v_previous.id else null end,
    'active',
    greatest(0::real, least(1::real, coalesce(p_confidence, 0.75))),
    v_fact_type,
    p_temporal_scope,
    p_project_scope
  )
  returning * into v_inserted;

  update public.users as app_user
  set user_memory_usage_bytes = greatest(
    coalesce(app_user.user_memory_usage_bytes, 0) + octet_length(v_inserted.summary),
    0
  )
  where app_user.id = p_user_id;

  return query select
    to_jsonb(v_inserted),
    false,
    false,
    case when v_previous.id is not null then v_previous.id else null end;
end;
$$;

-- Preserve the existing public server contract while routing automatic inserts
-- through lifecycle-aware confirmation and supersession.
drop function if exists public.insert_automatic_memory_once(
  uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, text
);

create function public.insert_automatic_memory_once(
  p_user_id uuid,
  p_type text,
  p_summary text,
  p_importance integer,
  p_embedding jsonb,
  p_embedding_model text,
  p_embedding_created_at timestamptz,
  p_scope text,
  p_chat_id uuid,
  p_automatic_idempotency_key text
)
returns table(
  id uuid,
  user_id uuid,
  type text,
  summary text,
  importance integer,
  embedding jsonb,
  embedding_model text,
  embedding_created_at timestamptz,
  scope text,
  chat_id uuid,
  created_at timestamptz,
  deduplicated boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_result record;
  v_memory jsonb;
begin
  select lifecycle.*
  into v_result
  from public.persist_memory_with_lifecycle(
    p_user_id => p_user_id,
    p_type => p_type,
    p_summary => p_summary,
    p_importance => p_importance,
    p_embedding => p_embedding,
    p_embedding_model => p_embedding_model,
    p_embedding_created_at => p_embedding_created_at,
    p_scope => p_scope,
    p_chat_id => p_chat_id,
    p_source_conversation_id => p_chat_id,
    p_automatic_idempotency_key => p_automatic_idempotency_key
  ) as lifecycle;

  v_memory := v_result.memory;
  return query select
    (v_memory ->> 'id')::uuid,
    (v_memory ->> 'user_id')::uuid,
    v_memory ->> 'type',
    v_memory ->> 'summary',
    (v_memory ->> 'importance')::integer,
    v_memory -> 'embedding',
    v_memory ->> 'embedding_model',
    nullif(v_memory ->> 'embedding_created_at', '')::timestamptz,
    v_memory ->> 'scope',
    nullif(v_memory ->> 'chat_id', '')::uuid,
    (v_memory ->> 'created_at')::timestamptz,
    coalesce(v_result.deduplicated, false);
end;
$$;

create or replace function public.search_memories_lexical(
  p_user_id uuid,
  p_query text,
  p_conversation_id uuid default null,
  p_limit integer default 24
)
returns table(
  id uuid,
  user_id uuid,
  type text,
  summary text,
  importance integer,
  embedding jsonb,
  embedding_model text,
  embedding_created_at timestamptz,
  scope text,
  chat_id uuid,
  created_at timestamptz,
  subject_key text,
  fact_type text,
  source_conversation_id uuid,
  source_message_id uuid,
  last_confirmed_at timestamptz,
  supersedes_memory_id uuid,
  status text,
  confidence real,
  temporal_scope text,
  project_scope text,
  exact_phrase_match boolean,
  entity_or_project_match boolean,
  lexical_rank real,
  scope_rank real,
  recency_rank real,
  anchor_rank real,
  retrieval_rank real
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with parameters as (
    select
      lower(regexp_replace(btrim(coalesce(p_query, '')), '[[:space:]]+', ' ', 'g')) as normalized_query,
      websearch_to_tsquery('english', coalesce(p_query, '')) as ts_query,
      greatest(1, least(coalesce(p_limit, 24), 60)) as result_limit
  ),
  scored as (
    select
      memory.*,
      (
        length(parameters.normalized_query) between 4 and 160
        and (
          position(parameters.normalized_query in lower(memory.summary)) > 0
          or (
            length(memory.summary) <= 160
            and position(lower(memory.summary) in parameters.normalized_query) > 0
          )
        )
      ) as exact_phrase_match,
      (
        memory.type in ('identity', 'project')
        and exists (
          select 1
          from regexp_split_to_table(parameters.normalized_query, '[^[:alnum:]_]+') as query_token(token)
          where length(query_token.token) >= 3
            and query_token.token not in (
              'the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'when',
              'where', 'about', 'your', 'have', 'does', 'project', 'memory', 'remember'
            )
            and (
              position(query_token.token in lower(memory.summary)) > 0
              or position(query_token.token in lower(memory.subject_key)) > 0
              or position(query_token.token in lower(coalesce(memory.project_scope, ''))) > 0
            )
        )
      ) as entity_or_project_match,
      case
        when numnode(parameters.ts_query) = 0 then 0::real
        else ts_rank_cd(memory.search_vector, parameters.ts_query, 32)::real
      end as lexical_rank,
      case when memory.scope = 'chat' and memory.chat_id = p_conversation_id then 1::real else 0.35::real end as scope_rank,
      (1.0 / (1.0 + greatest(0, extract(epoch from (now() - memory.last_confirmed_at)) / 86400.0) / 30.0))::real as recency_rank,
      case
        when memory.importance >= 8 and memory.fact_type in (
          'stable_identity', 'stable_preference', 'active_project_state', 'unresolved_commitment'
        ) then 1::real
        else 0::real
      end as anchor_rank
    from public.memories as memory
    cross join parameters
    where memory.user_id = p_user_id
      and memory.status = 'active'
      and (
        memory.scope = 'global'
        or (memory.scope = 'chat' and memory.chat_id = p_conversation_id)
      )
  ),
  eligible as (
    select
      scored.*,
      (
        case when scored.exact_phrase_match then 100 else 0 end +
        case when scored.entity_or_project_match then 30 else 0 end +
        scored.lexical_rank * 24 +
        scored.importance * 0.9 +
        scored.scope_rank * 6 +
        scored.recency_rank * 3 +
        scored.anchor_rank * 5
      )::real as retrieval_rank
    from scored
    cross join parameters
    where scored.exact_phrase_match
      or scored.entity_or_project_match
      or scored.lexical_rank > 0
      or scored.anchor_rank > 0
      or (scored.scope = 'chat' and scored.chat_id = p_conversation_id)
  )
  select
    eligible.id,
    eligible.user_id,
    eligible.type,
    eligible.summary,
    eligible.importance,
    eligible.embedding,
    eligible.embedding_model,
    eligible.embedding_created_at,
    eligible.scope,
    eligible.chat_id,
    eligible.created_at,
    eligible.subject_key,
    eligible.fact_type,
    eligible.source_conversation_id,
    eligible.source_message_id,
    eligible.last_confirmed_at,
    eligible.supersedes_memory_id,
    eligible.status,
    eligible.confidence,
    eligible.temporal_scope,
    eligible.project_scope,
    eligible.exact_phrase_match,
    eligible.entity_or_project_match,
    eligible.lexical_rank,
    eligible.scope_rank,
    eligible.recency_rank,
    eligible.anchor_rank,
    eligible.retrieval_rank
  from eligible
  cross join parameters
  order by
    eligible.exact_phrase_match desc,
    eligible.entity_or_project_match desc,
    eligible.lexical_rank desc,
    eligible.anchor_rank desc,
    eligible.scope_rank desc,
    eligible.importance desc,
    eligible.last_confirmed_at desc,
    eligible.id desc
  limit (select result_limit from parameters);
$$;

revoke all on function public.normalize_memory_subject_key(text, text, text) from public, anon;
revoke all on function public.infer_memory_fact_type(text, text) from public, anon;
revoke all on function public.persist_memory_with_lifecycle(
  uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, uuid, uuid,
  text, text, real, text, text, text
) from public, anon, authenticated;
revoke all on function public.insert_automatic_memory_once(
  uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.search_memories_lexical(uuid, text, uuid, integer) from public, anon;

grant execute on function public.normalize_memory_subject_key(text, text, text)
  to authenticated, service_role;
grant execute on function public.infer_memory_fact_type(text, text)
  to authenticated, service_role;
grant execute on function public.persist_memory_with_lifecycle(
  uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, uuid, uuid,
  text, text, real, text, text, text
) to service_role;
grant execute on function public.insert_automatic_memory_once(
  uuid, text, text, integer, jsonb, text, timestamptz, text, uuid, text
) to service_role;
grant execute on function public.search_memories_lexical(uuid, text, uuid, integer)
  to authenticated, service_role;

comment on function public.search_memories_lexical(uuid, text, uuid, integer) is
  'Searches the full active memory collection with weighted FTS, exact/entity boosts, active-chat scope, importance anchors, and recency without generating embeddings.';

create or replace function public.get_memory_hybrid_retrieval_schema_version()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select '20260805150000'::text;
$$;

revoke all on function public.get_memory_hybrid_retrieval_schema_version() from public, anon, authenticated;
grant execute on function public.get_memory_hybrid_retrieval_schema_version() to service_role;
