\set ON_ERROR_STOP on

-- Reuse the complete Phase 3 schema and lifecycle regression as the baseline.
\i backend/testMemoryHybridRetrieval.sql

\i supabase/migrations/20260805220000_add_cross_conversation_continuity.sql
\i supabase/migrations/20260805220100_upgrade_fast_cross_conversation_snapshot.sql
\i supabase/migrations/20260805220150_preserve_fast_snapshot_contract.sql

-- Seed more than the former 24-conversation boundary. The relevant SentIQ
-- conversation is deliberately older than all unrelated conversations.
insert into public.conversations(id, user_id, title, created_at)
values (
  '21000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'SentIQ latency work',
  '2024-01-01T00:00:00Z'
);

insert into public.context_capsules(
  id, owner_user_id, scope, conversation_id, content,
  source_message_count, source_cursor, version, updated_at
)
values (
  '41000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'conversation',
  '21000000-0000-4000-8000-000000000001',
  'Wave 0 attributed first-token latency. The selected next step was parallel input safety plus speculative provider generation while preserving answer quality and keeping minReplicas at zero.',
  18,
  null,
  3,
  '2024-01-02T00:00:00Z'
);

insert into public.messages(id, conversation_id, role, content, created_at)
values
  (
    '71000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'user',
    'Continue the SentIQ latency audit without increasing minReplicas.',
    '2024-01-01T01:00:00Z'
  ),
  (
    '71000000-0000-4000-8000-000000000002',
    '21000000-0000-4000-8000-000000000001',
    'assistant',
    'The decision was to preserve minReplicas at zero and test speculative provider generation next.',
    '2024-01-01T01:01:00Z'
  ),
  (
    '71000000-0000-4000-8000-000000000003',
    '21000000-0000-4000-8000-000000000001',
    'assistant',
    'SentIQ latency is an interesting topic and I hope your day is going well.',
    '2024-01-01T01:02:00Z'
  );

insert into public.conversations(id, user_id, title, created_at)
select
  ('22000000-0000-4000-8000-' || lpad(series.value::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001',
  'Unrelated recent conversation ' || series.value,
  now() - make_interval(hours => series.value)
from generate_series(1, 30) as series(value);

insert into public.context_capsules(
  owner_user_id, scope, conversation_id, content,
  source_message_count, source_cursor, version, updated_at
)
select
  '10000000-0000-4000-8000-000000000001',
  'conversation',
  ('22000000-0000-4000-8000-' || lpad(series.value::text, 12, '0'))::uuid,
  'Unrelated capsule about gardening note ' || series.value,
  4,
  null,
  1,
  now() - make_interval(hours => series.value)
from generate_series(1, 30) as series(value);

select *
from public.persist_memory_with_lifecycle(
  p_user_id => '10000000-0000-4000-8000-000000000001',
  p_type => 'project',
  p_summary => 'The next SentIQ latency step is to test speculative provider generation.',
  p_importance => 9,
  p_scope => 'global',
  p_subject_key => 'commitment:sentiq_latency_next',
  p_fact_type => 'unresolved_commitment',
  p_project_scope => 'SentIQ latency',
  p_confidence => 0.95
);

create temporary table phase6_result as
select public.search_cross_conversation_context(
  '10000000-0000-4000-8000-000000000001',
  'continue the SentIQ latency work',
  '20000000-0000-4000-8000-000000000001',
  3,
  8,
  240
) as payload;

do $$
declare
  v_payload jsonb;
  v_capsules jsonb;
  v_evidence jsonb;
begin
  select payload into v_payload from phase6_result;
  v_capsules := v_payload -> 'project_capsules';
  v_evidence := v_payload -> 'source_evidence';

  if (v_payload ->> 'schema_version')::integer <> 1 then
    raise exception 'Phase 6 schema version mismatch: %', v_payload;
  end if;

  if jsonb_array_length(v_capsules) < 1 or jsonb_array_length(v_capsules) > 3 then
    raise exception 'Project capsule selection was not bounded to one through three: %', v_capsules;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_capsules) as item(value)
    where item.value ->> 'conversation_id' = '21000000-0000-4000-8000-000000000001'
      and item.value ->> 'provenance_kind' = 'capsule'
      and (item.value ->> 'supports_exact_claim')::boolean = false
  ) then
    raise exception 'Old SentIQ capsule was not recalled across the former recent-window boundary: %', v_capsules;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_evidence) as item(value)
    where item.value ->> 'message_id' = '71000000-0000-4000-8000-000000000001'
      and item.value ->> 'role' = 'user'
      and (item.value ->> 'supports_exact_claim')::boolean
  ) then
    raise exception 'Prior user source message was not returned with exact-claim provenance: %', v_evidence;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_evidence) as item(value)
    where item.value ->> 'message_id' = '71000000-0000-4000-8000-000000000002'
      and item.value ->> 'role' = 'assistant'
      and length(item.value ->> 'content') <= 240
  ) then
    raise exception 'Bounded assistant decision/outcome excerpt was not returned: %', v_evidence;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_evidence) as item(value)
    where item.value ->> 'message_id' = '71000000-0000-4000-8000-000000000003'
  ) then
    raise exception 'Ordinary assistant chatter leaked into decision/outcome evidence: %', v_evidence;
  end if;

  if jsonb_array_length(v_payload -> 'stable_user_capsule' -> 'facts') < 1 then
    raise exception 'Stable-user capsule did not contain active stable memory facts: %', v_payload;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_payload -> 'unresolved_work') as item(value)
    where item.value ->> 'subject_key' = 'commitment:sentiq_latency_next'
      and item.value ->> 'provenance_kind' = 'memory'
      and (item.value ->> 'supports_exact_claim')::boolean = false
  ) then
    raise exception 'Unresolved SentIQ work was not selected: %', v_payload -> 'unresolved_work';
  end if;
end;
$$;

create temporary table phase6_fast as
select public.get_fast_context_snapshot(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'continue the SentIQ latency work',
  null,
  array[]::uuid[],
  20,
  8,
  12
) as payload;

do $$
declare
  v_payload jsonb;
begin
  select payload into v_payload from phase6_fast;

  if (v_payload ->> 'schema_version')::integer <> 2 then
    raise exception 'Fast client compatibility schema was not preserved: %', v_payload;
  end if;

  if position(
    'SELECTED CROSS-CONVERSATION CONTINUITY'
    in coalesce(v_payload -> 'workspace_capsule' ->> 'content', '')
  ) = 0 then
    raise exception 'Fast single-RPC snapshot did not project Phase 6 continuity: %', v_payload;
  end if;

  if v_payload ? 'continuity' then
    raise exception 'Internal continuity payload leaked outside the compatibility adapter: %', v_payload;
  end if;
end;
$$;

select 'PASS | Phase 6 cross-conversation continuity PostgreSQL integration passed.' as result;
