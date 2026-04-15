# A-4 Runbook: Shard Migration Coverage Verification

## Objective
Ensure the A-4 critical shard-only migrations are present and healthy on every data shard (db2, db3, db4).

## Scope
- 20260406160000_capacity_limits.sql
- 20260407030000_chat_images_table.sql
- 20260412090000_incremental_memory_usage_tracking.sql
- Databases: db2, db3, db4

## Why This Matters
If shard coverage drifts, the backend can start with partially missing schema objects and fail at runtime for specific users routed to affected shards.

## Pre-Check SQL (run on each shard)
```sql
-- 20260406160000: capacity limit helper function exists
select exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_user_conversation_count'
) as has_capacity_limits;

-- 20260407030000: chat_images table exists
select exists (
  select 1
  from information_schema.tables
  where table_schema = 'public'
    and table_name = 'chat_images'
) as has_chat_images_table;

-- 20260412090000: memory tracking RPC + counter column exist
select
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'adjust_user_memory_usage'
  ) as has_adjust_user_memory_usage_rpc,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'user_memory_usage_bytes'
  ) as has_user_memory_usage_column;
```

Expected outcome on db2, db3, db4:
- has_capacity_limits = true
- has_chat_images_table = true
- has_adjust_user_memory_usage_rpc = true
- has_user_memory_usage_column = true

## App-Level Verification
Run:
```bash
npm run check:migrations
```

Expected outcome:
- Command exits 0
- No fatal migration-check logs

## Deployment Safety Sequence
1. Apply missing migration(s) on one shard at a time.
2. Re-run pre-check SQL on that shard.
3. Run npm run check:migrations.
4. Proceed to next shard only after success.

## Runtime Guardrail
The backend startup path also executes shard checks and fails hard on drift. This prevents serving traffic in a known bad schema state.

## Rollback Guidance
If a migration rollout fails on any shard:
1. Stop rollout.
2. Keep traffic on currently healthy shards.
3. Fix the failed shard migration state.
4. Re-run pre-check SQL and npm run check:migrations before resuming.
