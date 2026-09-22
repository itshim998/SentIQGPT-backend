-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Provides Fast mode with one bounded, read-only snapshot of durable context.
-- The function performs no embedding generation, capsule refresh, or writes.

create index if not exists messages_conversation_created_id_desc_idx
  on public.messages(conversation_id, created_at desc, id desc);

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
  search_query as (
    select websearch_to_tsquery('simple', coalesce(p_query, '')) as value
  ),
  ranked_memories as (
    select
      memory.id,
      memory.type,
      memory.summary,
      memory.importance,
      memory.scope,
      memory.chat_id,
      memory.created_at,
      case
        when numnode(search_query.value) = 0 then 0::real
        else ts_rank_cd(to_tsvector('simple', coalesce(memory.summary, '')), search_query.value)::real
      end as lexical_rank
    from public.memories memory
    cross join search_query
    cross join bounded
    where memory.user_id = p_owner_user_id
      and (
        memory.scope = 'global'
        or (memory.scope = 'chat' and memory.chat_id = p_conversation_id)
      )
      and (
        numnode(search_query.value) = 0
        or to_tsvector('simple', coalesce(memory.summary, '')) @@ search_query.value
      )
    order by
      lexical_rank desc,
      (memory.scope = 'chat') desc,
      memory.importance desc,
      memory.created_at desc,
      memory.id desc
    limit (select memory_limit from bounded)
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
          'lexical_rank', memory.lexical_rank
        )
        order by memory.lexical_rank desc, memory.importance desc, memory.created_at desc
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
  )
  select jsonb_build_object(
    'schema_version', 1,
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
  left join latest_message_cursor on true;
$$;

revoke all on function public.get_fast_context_snapshot(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) from public;
revoke all on function public.get_fast_context_snapshot(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) from anon;
grant execute on function public.get_fast_context_snapshot(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) to authenticated, service_role;
