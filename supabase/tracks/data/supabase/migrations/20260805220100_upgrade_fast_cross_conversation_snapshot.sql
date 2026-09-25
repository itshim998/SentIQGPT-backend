-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Keeps Fast mode read-only and single-RPC while including Phase 6 continuity
-- selection inside the existing snapshot response.

create or replace function public.get_fast_context_snapshot(
  p_owner_user_id uuid,
  p_conversation_id uuid,
  p_query text default '',
  p_client_request_id text default null,
  p_source_document_ids uuid[] default array[]::uuid[],
  p_message_limit integer default 20,
  p_memory_limit integer default 8,
  p_source_limit integer default 12
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with authorized_conversation as (
    select conversation.id
    from public.conversations conversation
    where conversation.id = p_conversation_id
      and conversation.user_id = p_owner_user_id
    limit 1
  ),
  bounded as (
    select
      greatest(1, least(coalesce(p_message_limit, 20), 40)) as message_limit,
      greatest(0, least(coalesce(p_memory_limit, 8), 20)) as memory_limit,
      greatest(0, least(coalesce(p_source_limit, 12), 24)) as source_limit
  ),
  latest_messages_desc as (
    select
      message.id,
      message.role,
      message.content,
      message.created_at,
      message.client_request_id,
      message.message_type
    from public.messages message
    join authorized_conversation authorized
      on authorized.id = message.conversation_id
    cross join bounded
    where not (
      message.role = 'user'
      and nullif(btrim(coalesce(p_client_request_id, '')), '') is not null
      and message.client_request_id = nullif(btrim(p_client_request_id), '')
    )
    order by message.created_at desc, message.id desc
    limit (select message_limit from bounded)
  ),
  latest_messages as (
    select *
    from latest_messages_desc
    order by created_at asc, id asc
  ),
  message_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', message.id,
          'role', message.role,
          'content', message.content,
          'created_at', message.created_at,
          'client_request_id', message.client_request_id,
          'message_type', message.message_type
        )
        order by message.created_at asc, message.id asc
      ),
      '[]'::jsonb
    ) as value
    from latest_messages message
  ),
  latest_message_cursor as (
    select jsonb_build_object(
      'id', message.id,
      'created_at', message.created_at
    ) as value
    from latest_messages message
    order by message.created_at desc, message.id desc
    limit 1
  ),
  conversation_capsule as (
    select capsule.*
    from public.context_capsules capsule
    join authorized_conversation authorized
      on authorized.id = capsule.conversation_id
    where capsule.owner_user_id = p_owner_user_id
      and capsule.scope = 'conversation'
    limit 1
  ),
  workspace_capsule as (
    select capsule.*
    from public.context_capsules capsule
    where capsule.owner_user_id = p_owner_user_id
      and capsule.scope = 'workspace'
      and capsule.conversation_id is null
    limit 1
  ),
  ranked_memories as (
    select lexical.*
    from authorized_conversation authorized
    cross join bounded
    cross join lateral public.search_memories_lexical(
      p_owner_user_id,
      p_query,
      authorized.id,
      bounded.memory_limit
    ) as lexical
  ),
  memory_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', memory.id,
          'type', memory.type,
          'summary', memory.summary,
          'importance', memory.importance,
          'scope', memory.scope,
          'chat_id', memory.chat_id,
          'created_at', memory.created_at,
          'subject_key', memory.subject_key,
          'fact_type', memory.fact_type,
          'last_confirmed_at', memory.last_confirmed_at,
          'status', memory.status,
          'confidence', memory.confidence,
          'project_scope', memory.project_scope,
          'temporal_scope', memory.temporal_scope,
          'exact_phrase_match', memory.exact_phrase_match,
          'entity_or_project_match', memory.entity_or_project_match,
          'lexical_rank', memory.lexical_rank,
          'retrieval_rank', memory.retrieval_rank,
          'anchor_rank', memory.anchor_rank
        )
        order by
          memory.exact_phrase_match desc,
          memory.entity_or_project_match desc,
          memory.retrieval_rank desc,
          memory.importance desc,
          memory.last_confirmed_at desc
      ),
      '[]'::jsonb
    ) as value
    from ranked_memories memory
  ),
  ranked_source_documents as (
    select
      document.id,
      document.conversation_id,
      document.title,
      document.original_filename,
      document.mime_type,
      document.source_type,
      document.status,
      document.metadata,
      document.created_at,
      case when document.id = any(coalesce(p_source_document_ids, array[]::uuid[])) then 1 else 0 end as explicit_turn_source
    from public.source_documents document
    cross join bounded
    where document.owner_user_id = p_owner_user_id
      and (
        document.id = any(coalesce(p_source_document_ids, array[]::uuid[]))
        or document.conversation_id = p_conversation_id
      )
    order by explicit_turn_source desc, document.created_at desc, document.id desc
    limit (select source_limit from bounded)
  ),
  source_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', document.id,
          'conversation_id', document.conversation_id,
          'title', document.title,
          'original_filename', document.original_filename,
          'mime_type', document.mime_type,
          'source_type', document.source_type,
          'status', document.status,
          'metadata', document.metadata,
          'created_at', document.created_at
        )
        order by document.explicit_turn_source desc, document.created_at desc, document.id desc
      ),
      '[]'::jsonb
    ) as value
    from ranked_source_documents document
  ),
  continuity_payload as (
    select public.search_cross_conversation_context(
      p_owner_user_id,
      p_query,
      authorized.id,
      3,
      6,
      700
    ) as value
    from authorized_conversation authorized
  )
  select jsonb_build_object(
    'schema_version', 3,
    'conversation_id', authorized.id,
    'messages', message_payload.value,
    'message_cursor', latest_message_cursor.value,
    'conversation_capsule', (
      select jsonb_build_object(
        'id', capsule.id,
        'scope', capsule.scope,
        'conversation_id', capsule.conversation_id,
        'content', capsule.content,
        'source_message_count', capsule.source_message_count,
        'source_cursor', capsule.source_cursor,
        'version', capsule.version,
        'updated_at', capsule.updated_at
      )
      from conversation_capsule capsule
    ),
    'workspace_capsule', (
      select jsonb_build_object(
        'id', capsule.id,
        'scope', capsule.scope,
        'conversation_id', capsule.conversation_id,
        'content', capsule.content,
        'source_message_count', capsule.source_message_count,
        'source_cursor', capsule.source_cursor,
        'version', capsule.version,
        'updated_at', capsule.updated_at
      )
      from workspace_capsule capsule
    ),
    'memories', memory_payload.value,
    'source_documents', source_payload.value,
    'continuity', continuity_payload.value,
    'cursors', jsonb_build_object(
      'message_id', latest_message_cursor.value ->> 'id',
      'message_created_at', latest_message_cursor.value ->> 'created_at',
      'conversation_capsule_source_cursor', (select capsule.source_cursor from conversation_capsule capsule),
      'conversation_capsule_version', (select capsule.version from conversation_capsule capsule),
      'workspace_capsule_source_cursor', (select capsule.source_cursor from workspace_capsule capsule),
      'workspace_capsule_version', (select capsule.version from workspace_capsule capsule)
    )
  )
  from authorized_conversation authorized
  cross join message_payload
  cross join memory_payload
  cross join source_payload
  cross join continuity_payload
  left join latest_message_cursor on true;
$$;

revoke all on function public.get_fast_context_snapshot(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) from public, anon;
grant execute on function public.get_fast_context_snapshot(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) to authenticated, service_role;

create or replace function public.get_fast_context_snapshot_schema_version()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select '20260805220100'::text;
$$;

revoke all on function public.get_fast_context_snapshot_schema_version()
  from public, anon, authenticated;
grant execute on function public.get_fast_context_snapshot_schema_version()
  to service_role;
