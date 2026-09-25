-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- The Phase 6 internal snapshot adds structured continuity. Preserve the current
-- application-facing schema_version=2 contract until the runtime is deployed by
-- adapting that internal payload through the existing single RPC. Continuity is
-- projected through the workspace-capsule slot with its provenance contract.

do $$
begin
  if to_regprocedure('public.get_fast_context_snapshot_phase6_internal(uuid,uuid,text,text,uuid[],integer,integer,integer)') is null then
    alter function public.get_fast_context_snapshot(
      uuid, uuid, text, text, uuid[], integer, integer, integer
    ) rename to get_fast_context_snapshot_phase6_internal;
  end if;
end;
$$;

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
  with internal as (
    select public.get_fast_context_snapshot_phase6_internal(
      p_owner_user_id,
      p_conversation_id,
      p_query,
      p_client_request_id,
      p_source_document_ids,
      p_message_limit,
      p_memory_limit,
      p_source_limit
    ) as payload
  ),
  adapted as (
    select
      payload,
      payload -> 'continuity' as continuity,
      case
        when jsonb_array_length(coalesce(payload -> 'continuity' -> 'project_capsules', '[]'::jsonb)) > 0
          or jsonb_array_length(coalesce(payload -> 'continuity' -> 'stable_user_capsule' -> 'facts', '[]'::jsonb)) > 0
          or jsonb_array_length(coalesce(payload -> 'continuity' -> 'unresolved_work', '[]'::jsonb)) > 0
          or jsonb_array_length(coalesce(payload -> 'continuity' -> 'source_evidence', '[]'::jsonb)) > 0
        then jsonb_build_object(
          'id', 'phase6-continuity',
          'scope', 'workspace',
          'conversation_id', null,
          'content',
            'SELECTED CROSS-CONVERSATION CONTINUITY. Read each provenance_kind and supports_exact_claim field strictly. '
            || 'Memory supports saved facts; capsules support broad continuity; only source_message excerpts support exact past claims.'
            || E'\n' || jsonb_pretty(payload -> 'continuity'),
          'source_message_count', jsonb_array_length(coalesce(payload -> 'continuity' -> 'source_evidence', '[]'::jsonb)),
          'source_cursor', null,
          'version', 1,
          'updated_at', now()
        )
        else payload -> 'workspace_capsule'
      end as workspace_payload
    from internal
  )
  select
    (payload - 'continuity' - 'workspace_capsule' - 'schema_version')
    || jsonb_build_object(
      'schema_version', 2,
      'workspace_capsule', workspace_payload
    )
  from adapted;
$$;

revoke all on function public.get_fast_context_snapshot_phase6_internal(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) from public, anon;
revoke all on function public.get_fast_context_snapshot(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) from public, anon;

grant execute on function public.get_fast_context_snapshot_phase6_internal(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) to authenticated, service_role;
grant execute on function public.get_fast_context_snapshot(
  uuid, uuid, text, text, uuid[], integer, integer, integer
) to authenticated, service_role;

comment on function public.get_fast_context_snapshot(uuid,uuid,text,text,uuid[],integer,integer,integer) is
  'Phase 6 compatibility adapter: one read-only RPC, schema_version 2, with selected continuity projected through the workspace capsule.';
