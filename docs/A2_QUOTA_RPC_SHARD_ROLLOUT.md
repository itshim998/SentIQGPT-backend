# A-2 Rollout Runbook: reserve_daily_llm_request on all shards

## Objective
Ensure the atomic quota RPC public.reserve_daily_llm_request(uuid, integer) exists and is executable by service_role on every database shard.

## Scope
- Migration file: supabase/migrations/20260326190000_atomic_llm_request_quota.sql
- Dependency migration: supabase/migrations/20260326213000_fix_multi_db_session_bootstrap.sql
- Databases: db1, db2, db3, db4

## Rollout order
1. Staging: db1 -> db2 -> db3 -> db4
2. Production: db2 -> db3 -> db4

## Pre-check SQL (run on each DB)
```sql
select
  current_database() as database_name,
  exists (
    select 1
    from information_schema.routines
    where routine_schema = 'public'
      and routine_name = 'reserve_daily_llm_request'
  ) as has_reserve_daily_llm_request;
```

## Permission check SQL (run on each DB)
```sql
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'reserve_daily_llm_request';
```

Expected result:
- service_role_can_execute = true
- authenticated_can_execute = false
- anon_can_execute = false

## Apply sequence when missing
1. If ensure_user_exists and ensure_daily_usage_row are not in expected post-fix form, apply:
   - supabase/migrations/20260326213000_fix_multi_db_session_bootstrap.sql
2. Apply:
   - supabase/migrations/20260326190000_atomic_llm_request_quota.sql
3. Re-run pre-check and permission check.

## Runtime verification after apply
1. Send authenticated traffic through:
   - POST /llm/invoke
   - POST /llm/stream
   - POST /llm/vision
2. Confirm logs include quota reserve RPC success messages.
3. Confirm logs do not include:
   - [quota] reserve.rpc_failed_fallback
   - [quota] reserve.rpc_missing_on_shard

## Safety notes
- Keep fallback path enabled during rollout to avoid user-facing outages.
- If a shard fails migration apply, pause rollout and continue serving with fallback while remediating.
- Do not proceed to next shard until checks pass on the current shard.
