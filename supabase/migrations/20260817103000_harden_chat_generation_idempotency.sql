-- Phase 21: atomic chat-generation idempotency.
-- The (user_id, client_request_id) key is the durable request identity.
-- Retries/concurrent duplicates must converge on the original generation.

create or replace function public.get_or_create_chat_generation(
  p_generation_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_client_request_id text,
  p_execution_mode text default null,
  p_model_route text default null,
  p_generation_session_id uuid default null,
  p_execution_snapshot jsonb default null
)
returns public.chat_generations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generations%rowtype;
  v_request_id text := nullif(btrim(coalesce(p_client_request_id, '')), '');
begin
  if v_request_id is null then
    raise exception 'client_request_id is required for idempotent chat generation';
  end if;

  -- Serialize callers for the same logical request. The unique index remains
  -- the final database invariant, while this lock makes read/create semantics
  -- deterministic under simultaneous retries.
  perform pg_advisory_xact_lock(hashtextextended(
    p_user_id::text || ':' || v_request_id,
    2147483647
  ));

  select * into v_row
  from public.chat_generations
  where user_id = p_user_id
    and client_request_id = v_request_id;

  if found then
    return v_row;
  end if;

  insert into public.chat_generations (
    id,
    conversation_id,
    user_id,
    client_request_id,
    status,
    execution_mode,
    model_route,
    generation_session_id,
    execution_snapshot,
    partial_text,
    tokens_generated,
    last_event_sequence
  )
  values (
    coalesce(p_generation_id, gen_random_uuid()),
    p_conversation_id,
    p_user_id,
    v_request_id,
    'queued',
    p_execution_mode,
    p_model_route,
    p_generation_session_id,
    coalesce(p_execution_snapshot, '{}'::jsonb),
    '',
    0,
    0
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.get_or_create_chat_generation(uuid,uuid,uuid,text,text,text,uuid,jsonb) from public;
revoke all on function public.get_or_create_chat_generation(uuid,uuid,uuid,text,text,text,uuid,jsonb) from anon;
revoke all on function public.get_or_create_chat_generation(uuid,uuid,uuid,text,text,text,uuid,jsonb) from authenticated;
grant execute on function public.get_or_create_chat_generation(uuid,uuid,uuid,text,text,text,uuid,jsonb) to service_role;
