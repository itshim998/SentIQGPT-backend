# DB4 constraint drift: proposed forward-only repair

Proposal only. No migration file was created and no database operation was executed for this proposal.

The earlier production audit found the historical CONTROL_ONLY version `20260922120000_retire_db4_assigned_db.sql` recorded on DB1 while `user_db_map_assigned_db_check` still allowed assignments from 2 through 4. It reported zero DB4 mappings. Those observations are historical; recheck them immediately before any later approved repair. Runtime routing permits DB2 and DB3 only.

The historical migration checks for DB4 rows, drops the named constraint and adds `CHECK (assigned_db BETWEEN 2 AND 3)`. Replaying or editing that recorded version would conceal drift and is inappropriate. The report does not establish why the live constraint diverged.

Use one new, unused timestamped CONTROL_ONLY migration in a separate reviewed change. Regenerate tracks and manifest at that time, leaving all historical SQL unchanged. With no intervening additions, canonical/control/data counts would become 86/26/69 (currently 85/25/69). Never put this repair on data shards.

The new migration should run within the migration runner's single DDL-and-native-history transaction:

1. Verify the target is DB1/control and inspect the current column definition, constraints, constraint name and migration history. Abort on unexpected state. Confirm `assigned_db` is still NOT NULL; preserve that requirement.
2. Set bounded local lock and statement timeouts. Acquire `LOCK TABLE public.user_db_map IN SHARE ROW EXCLUSIVE MODE` before checking rows. This blocks concurrent mapping writes through validation and replacement; schedule a brief maintenance window because the subsequent ALTER requires an ACCESS EXCLUSIVE lock.
3. Count DB4 mappings and all invalid assignments (`assigned_db IS NULL OR assigned_db NOT IN (2, 3)`) under that lock. Raise an exception if either count is nonzero. Do not silently reassign or delete user mappings. An operator must separately investigate any rows before retrying.
4. Atomically replace only `user_db_map_assigned_db_check` with a validated `CHECK (assigned_db BETWEEN 2 AND 3)` and update its comment. Do not use an unvalidated constraint as the final state. Preserve other constraints, RLS, ACLs, indexes and routing data.
5. Before commit, verify the normalized definition, validation flag, unchanged row count and zero invalid mappings. In a disposable fixture, prove assignments 2/3 work, 1/4/NULL fail, and a concurrent insert of 4 cannot slip between the count and ALTER. Production negative probes, if separately authorized, must run in rollback-only savepoints without creating synthetic users.
6. Record only the new native migration version in the same transaction and commit. A timeout or failed assertion must roll back both DDL and history. Re-read the committed definition and native version with a read-only check.

An aborted transaction leaves the old constraint and history intact. After a committed repair, any necessary rollback must itself be a separately reviewed forward migration; do not delete native history or widen the constraint merely to hide an application error. Runtime already rejects DB4, so tightening the database constraint aligns the existing contract without changing routing, quotas or billing.

No new repair migration, history row, deployment workflow or infrastructure change is included in the image-edit review branch. The existing image-edit deployment helper intentionally refuses pending mutation when this historical drift is detected; do not bypass that guard.
