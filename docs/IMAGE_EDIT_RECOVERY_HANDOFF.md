# Image edit recovery, DB4 repair and local CI validation

Branch: `feature/paid-image-editing-backend-review`; existing draft PR #93. The local starting commit was `3ad3187d0b28073f1272b73d53954cf9ca4d9cf2`. The clean branch was fast-forwarded to the independently reviewed remote commit `a54c77e4270710bbc359c9a7b96abe9f9c219a1f` before any edit. The commit containing this handoff is the final update; its SHA is reported with the branch push.

## Recovery correction

Previously, replay of a checkpointed but incomplete edit loaded the parent image bytes, and `claim_image_edit` independently required its original `chat_images` row. Deleting that parent after inference stranded a recoverable artifact, even though its original source UUID/hash remained in operation metadata.

The service now recognizes only trusted `storing`/`generated` checkpoints, verifies the stored fingerprint against the normalized request, operation, request ID and metadata-bound original source identity/hash, and checks current paid entitlement and conversation ownership. It calls a new recovery-only RPC that locks the existing request, rechecks ownership, exact artifact and metadata identities, and acquires only an expired lease. It never inserts a request or moves a request into inference. Fresh and uninvoked requests continue through the original source ownership/file checks and original claim RPC; ambiguous invocations cannot use recovery.

Recovery checks actual Storage bytes, size and SHA-256 before reservation/settlement. A storing checkpoint is finalized through the existing immutable-version RPC; generated output must still have its correctly bound image row. Deleted output rows are not resurrected. The generated state can now transition to failed for a verified missing artifact, permitting the existing release policy to finish. Transient storage/integrity errors leave the checkpoint retryable without settlement. Concurrent completion re-enters the completed-replay checks rather than returning an unchecked stale URL.

The independent review's completed-replay checks remain intact: deleted/mismatched image rows, assistant messages and missing objects are rejected, while valid completed edits survive parent deletion. Temporary lookup/Storage failures return recovery-unavailable rather than false deletion errors. Free/guest requests remain denied before billing or inference. Plan quotas, weighted credit costs, generation fallbacks, source files and text billing are unchanged. The original source identity is returned from trusted metadata when its nullable foreign key has been cleared.

## Forward migrations and live evidence

| Version | Scope and targets | Canonical SHA-256 |
| --- | --- | --- |
| `20261024161000_repair_db4_assignment_constraint` | CONTROL_ONLY, DB1 | `5dbbb7aa98d4a1e0ad7a2956e184c93ac079c0367d0c36267295c251c834841f` |
| `20261024162000_image_edit_artifact_recovery` | DATA_ONLY, DB2/DB3 | `1c544d7afe892dac7744d1b10b62fed44f699b949eb8f8fa9a2965a72a48aade` |

The DB4 repair validates the schema and prerequisite history, takes an ACCESS EXCLUSIVE mapping-table lock before checking rows, uses bounded timeouts, rejects all invalid/NULL mappings, and replaces only the intended constraint. It preserves mappings, other constraints, indexes, triggers, RLS and grants. The data migration adds `claim_image_edit_recovery` and narrowly extends `transition_image_edit`; it leaves the original fresh claim function unchanged. Both migration track layouts and manifest are regenerated: 87 canonical, 26 control and 70 data versions.

The allowlisted deployment helper verified authenticated project identity, exact native history, old RPC bodies/ACLs, schema prerequisites, immutable original hashes, pending versions and lock risk on all targets before writing. Complete DDL/native-history transactions were first dry-run and rolled back on all three databases, with old definitions/history reverified. No blanket migration runner, history rewrite, DB4 target or application deployment was used.

Final live evidence is in [IMAGE_EDIT_RECOVERY_DEPLOYMENT.json](IMAGE_EDIT_RECOVERY_DEPLOYMENT.json):

| Database | Verified result |
| --- | --- |
| DB1 `lzgohufdrqjdupfsvqlj` | New repair recorded; 26 native versions; constraint now `CHECK (((assigned_db >= 2) AND (assigned_db <= 3)))`; zero invalid mappings; all five mappings and billing plans unchanged |
| DB2 `dyrwqeesibzzfifljklk` | Recovery recorded; 70 native versions; exact RPC bodies/signatures and service-only ACLs verified; PostgREST exposes recovery RPC |
| DB3 `fpklxhhsvjbjetkxqajg` | Recovery recorded; 70 native versions; exact RPC bodies/signatures and service-only ACLs verified; PostgREST exposes recovery RPC |

The initial application run stopped at a DB2 post-commit history-verification error. Read-only inspection proved DB2 had committed. The cause was a verifier dollar-quote delimiter colliding with the stored SQL body; the corrected verifier is executed and tamper-tested in isolated PostgreSQL. DB1/DB2 were verified read-only and skipped on resume; only still-pending DB3 was applied. The sanitized report retains that initial attempt so a partial result is not concealed. No committed migration was replayed.

The original deployed image-edit SQL and all four copies remain byte-identical:

- `20261024120000_paid_image_edit_ledger.sql`: `1d593d41c9f082de622a131a54ffb940e401530c3fb58686bbd6ad5a44bee289`.
- `20261024121000_image_edit_versions.sql`: `0d7cd7cf1d44575f7f97559242db141d7cb00b399fd9a02c0ecbbd5c36f95afd`.

## Local validation and CI limits

All 32 final local checks passed; exact commands, exit codes and counts are in [IMAGE_EDIT_RECOVERY_TEST_RESULTS.json](IMAGE_EDIT_RECOVERY_TEST_RESULTS.json). This includes build, 21 image-editing tests, image-edit billing, 84 isolated PostgreSQL assertions, 4 existing deployment tests, 4 new deployment tests, 12 migration checks, Priority 5, token allowances, unified token/routing policy, quota UI, shard topology, existing image generation/routing/persistence/Storage/recovery/tool regressions, the 11-gate frontend aggregate and whitespace checks.

Tests cover parent deletion with NULL foreign keys in both storing/generated states, active and expired leases, competing recoveries, changed fingerprints/operations/artifacts, foreign ownership, source-less uninvoked/ambiguous requests, lost claim/checkpoint/completion responses, actual object hashing, missing/corrupt output, one charge/version/message, paid-plan changes, Free rejection, atomic DDL/history rollback, tampered native history and DB4 assignments 2/3 versus 1/4/NULL. The temporary PGlite engine runs real PostgreSQL functions, but serializes connections; it does not establish independent-worker/load behavior.

`testTokenAllowances.ts` is an in-memory repository/usage fixture, not an external-database integration suite. It passes with the current visible and accessible “Includes input and output.” text, preserving its arithmetic, release, token ceiling and concurrency assertions. `testPriority5Stability.ts` passes with the reviewed `serverLegacy.ts` correction. An intermediate TypeScript null-narrowing error introduced while refactoring was fixed and the build/image suites rerun successfully.

No destructive test ran against production. Native `psql` integration suites requiring `SENTIQ_BILLING_TEST_DATABASE_URL` and destructive opt-in were not executed: no native PostgreSQL test server/psql was available, and the installed Docker client had no running daemon. They remain CI/staging validation, alongside live paid model inference, JWT/Storage end-to-end and independent-worker/network-fault tests. No GitHub workflow was modified or dispatched. Local checks preceded the single branch push; remote CI status must be read separately and is not inferred from local success.

## Security and rollout

Project-specific credentials remained in memory/HTTP headers. `.env`, secret values and credential files are excluded. Error output and committed reports contain sanitized statuses, public project references and schema evidence only. No provider call, backend deployment, master push, merge, deployment workflow dispatch or customer-row test mutation occurred. Only the two new migration versions were applied under the user's explicit authorization.

The backend fix remains on the review branch pending application rollout. The public bucket, one-MiB object limit, process-local queue/cooldown and provider-side inference uncertainty remain. Recovery requires replay and a paid account; unreplayed failures rely on reservation expiry. Deletion of an output row itself deliberately blocks recovery. Orphaned staging objects still need a separate reviewed reconciliation process. Erasing/background removal remain unsupported; live model inference remains unverified; no dedicated editor UI was added. These local and database checks do not establish production readiness.

## Complete changed-file inventory for this update

```text
backend/billing/testTokenAllowances.ts
backend/services/imageEditingService.ts
backend/testImageEditing.ts
docs/DB4_CONSTRAINT_REPAIR_PROPOSAL.md
docs/IMAGE_EDIT_RECOVERY_DEPLOYMENT.json
docs/IMAGE_EDIT_RECOVERY_HANDOFF.md
docs/IMAGE_EDIT_RECOVERY_TEST_RESULTS.json
package.json
scripts/deployImageEditRecoveryMigrations.mjs
scripts/generateMigrationTracks.mjs
scripts/testImageEditRecoveryDeployment.mjs
scripts/testImageEditSql.mjs
supabase/migration-manifest.json
supabase/migrations/20261024161000_repair_db4_assignment_constraint.sql
supabase/migrations/20261024162000_image_edit_artifact_recovery.sql
supabase/tracks/control/migrations/20261024161000_repair_db4_assignment_constraint.sql
supabase/tracks/control/supabase/migrations/20261024161000_repair_db4_assignment_constraint.sql
supabase/tracks/data/migrations/20261024162000_image_edit_artifact_recovery.sql
supabase/tracks/data/supabase/migrations/20261024162000_image_edit_artifact_recovery.sql
```
