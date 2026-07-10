-- SentIQ Chat startup verification RPC for data shards.
--
-- RUN ON: Databases 2, 3, 4 only (data shards; never the control DB).

create or replace function public.verify_sentiq_data_shard_startup(
  p_probe_user_id uuid,
  p_verify_live boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_failures jsonb := '[]'::jsonb;
  v_timings jsonb := '[]'::jsonb;
  v_group_started_at timestamptz;
begin
  v_group_started_at := clock_timestamp();

  begin
    perform public.initialize_user_session(p_probe_user_id);
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'core',
      'check', 'initialize_user_session',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform public.get_user_conversation_count(p_probe_user_id);
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'core',
      'check', 'get_user_conversation_count',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  v_timings := v_timings || jsonb_build_array(jsonb_build_object(
    'group', 'core',
    'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
  ));

  v_group_started_at := clock_timestamp();

  begin
    perform id
    from public.chat_images
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'generated-files',
      'check', 'chat_images',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform id
    from public.generated_files
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'generated-files',
      'check', 'generated_files',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform file_url, file_name, file_format, mime_type, generated_file_id, preview_json
    from public.messages
    where id = p_probe_user_id
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'generated-files',
      'check', 'messages_generated_file_columns',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform storage_bucket, content_sha256, version, updated_at
    from public.generated_files
    where id = p_probe_user_id
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'generated-files',
      'check', 'generated_files_private_columns',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  v_timings := v_timings || jsonb_build_array(jsonb_build_object(
    'group', 'generated-files',
    'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
  ));

  v_group_started_at := clock_timestamp();

  begin
    perform user_id, client_request_id, conversation_id
    from public.conversation_turn_requests
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'conversation',
      'check', 'conversation_turn_requests',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform old_conversation_id, canonical_conversation_id, user_id
    from public.conversation_aliases
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'conversation',
      'check', 'conversation_aliases',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform public.resolve_conversation_for_turn(
      p_probe_user_id,
      'startup-probe-' || p_probe_user_id::text,
      p_probe_user_id,
      'Startup Probe'
    );
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'conversation',
      'check', 'resolve_conversation_for_turn',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform public.list_user_conversations(p_probe_user_id);
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'conversation',
      'check', 'list_user_conversations',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform last_activity_at
    from public.conversations
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'conversation',
      'check', 'conversations_last_activity_at',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  v_timings := v_timings || jsonb_build_array(jsonb_build_object(
    'group', 'conversation',
    'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
  ));

  v_group_started_at := clock_timestamp();

  begin
    perform public.adjust_user_memory_usage(p_probe_user_id, 0);
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'memory',
      'check', 'adjust_user_memory_usage',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform public.repair_user_memory_usage(p_probe_user_id);
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'memory',
      'check', 'repair_user_memory_usage',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform user_memory_usage_bytes
    from public.users
    where id = p_probe_user_id
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'memory',
      'check', 'users_user_memory_usage_bytes',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform embedding_backfill_requested_at,
      embedding_backfill_attempts,
      embedding_backfill_last_attempt_at,
      embedding_backfill_error
    from public.memories
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'memory',
      'check', 'memories_backfill_columns',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  v_timings := v_timings || jsonb_build_array(jsonb_build_object(
    'group', 'memory',
    'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
  ));

  v_group_started_at := clock_timestamp();

  begin
    perform id, owner_user_id, conversation_id, content_hash, status, metadata
    from public.source_documents
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'source-retrieval',
      'check', 'source_documents',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform id,
      document_id,
      parent_chunk_id,
      chunk_role,
      chunk_index,
      token_estimate,
      embedding_status,
      fts
    from public.source_chunks
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'source-retrieval',
      'check', 'source_chunks',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform public.search_source_chunks(p_probe_user_id, array[]::uuid[], 'startup probe', 1);
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'source-retrieval',
      'check', 'search_source_chunks',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform id,
      user_id,
      conversation_id,
      message_id,
      status,
      content,
      sources,
      request_metadata,
      search_count,
      citation_count
    from public.deep_research_reports
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'source-retrieval',
      'check', 'deep_research_reports',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  v_timings := v_timings || jsonb_build_array(jsonb_build_object(
    'group', 'source-retrieval',
    'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
  ));

  if coalesce(p_verify_live, false) then
    v_group_started_at := clock_timestamp();

    begin
      perform session_id, owner_user_id, status, audio_started_at, reserved_seconds, used_seconds
      from public.live_sessions
      limit 1;
    exception when others then
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'group', 'live',
        'check', 'live_sessions_lifecycle',
        'code', sqlstate,
        'message', left(sqlerrm, 240)
      ));
    end;

    begin
      perform public.mark_live_session_started(p_probe_user_id, p_probe_user_id, 30);
    exception when others then
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'group', 'live',
        'check', 'mark_live_session_started',
        'code', sqlstate,
        'message', left(sqlerrm, 240)
      ));
    end;

    v_timings := v_timings || jsonb_build_array(jsonb_build_object(
      'group', 'live',
      'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
    ));
  end if;

  v_group_started_at := clock_timestamp();

  begin
    delete from public.usage_logs
    where user_id = p_probe_user_id;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'cleanup',
      'check', 'usage_logs_delete',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    delete from public.users
    where id = p_probe_user_id;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'cleanup',
      'check', 'users_delete',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  v_timings := v_timings || jsonb_build_array(jsonb_build_object(
    'group', 'cleanup',
    'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
  ));

  return jsonb_build_object(
    'ok', jsonb_array_length(v_failures) = 0,
    'failures', v_failures,
    'timings', v_timings
  );
end;
$$;

revoke all on function public.verify_sentiq_data_shard_startup(uuid, boolean) from public;
revoke all on function public.verify_sentiq_data_shard_startup(uuid, boolean) from anon;
revoke all on function public.verify_sentiq_data_shard_startup(uuid, boolean) from authenticated;
grant execute on function public.verify_sentiq_data_shard_startup(uuid, boolean) to service_role;
