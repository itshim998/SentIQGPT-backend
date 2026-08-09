-- Read-only post-migration verification for SentIQ Chat conversation ordering.
-- RUN ON: Database 2, 3, 4 after applying
--          20260809123000_conversation_user_activity_ordering.sql
-- EXPECT: one row where ready = true and every numeric failure count is 0.

with
version_check as (
  select public.get_conversation_user_activity_schema_version() as schema_version
),
activity_mismatches as (
  select count(*)::bigint as mismatch_count
  from public.conversations c
  where c.last_activity_at is distinct from coalesce(
    (
      select max(m.created_at)
      from public.messages m
      where m.conversation_id = c.id
        and (
          m.role = 'user'
          or (
            m.role = 'assistant'
            and m.message_type = 'live_transcript'
            and coalesce(m.content, '') ~ E'(^|\\n)You:[[:space:]]*[^[:space:]]'
          )
        )
    ),
    c.created_at
  )
),
over_limit_users as (
  select count(*)::bigint as user_count
  from (
    select c.user_id
    from public.conversations c
    group by c.user_id
    having count(*) > 50
  ) q
),
function_contracts as (
  select
    pg_get_functiondef('public.touch_conversation_last_activity()'::regprocedure) as touch_def,
    pg_get_functiondef('public.list_user_conversations(uuid)'::regprocedure) as list_def,
    pg_get_functiondef('public.enforce_conversation_limit()'::regprocedure) as limit_def
),
contract_checks as (
  select
    position('new.role = ''user''' in lower(touch_def)) > 0 as direct_user_touch,
    position('new.message_type = ''live_transcript''' in lower(touch_def)) > 0
      and position('you:' in lower(touch_def)) > 0 as live_user_touch,
    position('coalesce(c.last_activity_at, c.created_at) desc' in lower(list_def)) > 0 as newest_first_list,
    position('last_message_at' in lower(list_def)) > 0 as last_message_metadata_present,
    position('max_conversations constant integer := 50' in lower(limit_def)) > 0 as exact_limit_50,
    position('coalesce(c.last_activity_at, c.created_at) asc' in lower(limit_def)) > 0 as oldest_first_eviction,
    position('conversation_retention_artifact_cleanup_required' in lower(limit_def)) > 0 as artifact_safe_fallback
  from function_contracts
)
select
  (
    v.schema_version = '20260809123000'
    and a.mismatch_count = 0
    and o.user_count = 0
    and c.direct_user_touch
    and c.live_user_touch
    and c.newest_first_list
    and c.last_message_metadata_present
    and c.exact_limit_50
    and c.oldest_first_eviction
    and c.artifact_safe_fallback
  ) as ready,
  v.schema_version,
  a.mismatch_count as conversation_activity_mismatches,
  o.user_count as users_over_50_conversations,
  c.direct_user_touch,
  c.live_user_touch,
  c.newest_first_list,
  c.last_message_metadata_present,
  c.exact_limit_50,
  c.oldest_first_eviction,
  c.artifact_safe_fallback
from version_check v
cross join activity_mismatches a
cross join over_limit_users o
cross join contract_checks c;
