Production migration and integration report — 24 October 2026

**Result: both image-edit migration versions were applied to all three intended production databases and independently verified.** No backend application code was deployed, committed or pushed. All original uncommitted image-edit implementation work remains present. HEAD is still `66d8077e529a42e3be205d028ff86a9e386986a7` on `master`.

One separate, pre-existing schema drift remains: DB1 records migration `20260922120000_retire_db4_assigned_db`, but its `user_db_map_assigned_db_check` still allows values 2 through 4 instead of 2 through 3. An aggregate live inspection found **zero mappings to DB4**. Runtime routing permits only DB1/DB2/DB3, assignment uses DB2/DB3, deployment workflows exclude DB4, and no DB4 credentials or target were used. This historical constraint/history discrepancy was diagnosed and documented without replaying a historical migration, changing mappings, repairing history, or expanding the authorized two-migration deployment. The new deployer now refuses any pending migration mutation when this recorded prerequisite drift is present; verification of already-deployed image-edit objects remains available.

**Database identification and execution**

| DB | Verified project reference | Actual role and evidence | Credentials available | Migration and outcome |
| --- | --- | --- | --- | --- |
| DB1 | `lzgohufdrqjdupfsvqlj` | Control: `billing_plans`, `user_subscriptions`, `user_db_map`, `quota_reservations`, `usage_events`; no `chat_images` or `chat_generations` | Yes | `20261024120000_paid_image_edit_ledger.sql`: applied, then already-applied state independently verified; history 24 → 25 |
| DB2 | `dyrwqeesibzzfifljklk` | Data Shard 1: `users`, `conversations`, `messages`, `chat_images`, `chat_generations`; no control ledger/plan tables | Yes | `20261024121000_image_edit_versions.sql`: applied and independently verified; history 68 → 69 |
| DB3 | `fpklxhhsvjbjetkxqajg` | Data Shard 2: the same data-shard contract, checked independently | Yes | `20261024121000_image_edit_versions.sql`: applied and independently verified; history 68 → 69 |

Each reference matched its configured Supabase URL, historical deployment scripts and authenticated Management API project metadata. All three project IDs are distinct and were `ACTIVE_HEALTHY`; DB1 is in `ap-northeast-2`, DB2/DB3 in `ap-south-1`. Project-specific PATs and service-role credentials were available and validated independently; no generic-token fallback was used. DB4 received nothing.

The manifest and both copies of each isolated track match canonical files and SHA-256 checksums: **85 canonical migrations, 25 control-track migrations, 69 data-track migrations**. Each target migration is recorded exactly once; the final verification found zero pending local versions on each project. Unrelated migration versions were preserved.

| Artifact | SHA-256 actually reviewed and deployed |
| --- | --- |
| Control ledger migration | `1d593d41c9f082de622a131a54ffb940e401530c3fb58686bbd6ad5a44bee289` |
| Data versions migration, identically on DB2/DB3 | `0d7cd7cf1d44575f7f97559242db141d7cb00b399fd9a02c0ecbbd5c36f95afd` |

**Deployment mechanism and safety evidence**

The new `scripts/deployImageEditMigrations.mjs` uses the documented PAT-authenticated [Management API SQL endpoint](https://supabase.com/docs/reference/api/v1-run-a-query). DB1 has no configured direct PostgreSQL password/URL, and the [migration creation endpoint](https://supabase.com/docs/reference/api/v1-apply-a-migration) does not expose a caller-specified version in its request schema. The selected method preserves the exact repository versions without inventing connection credentials or creating a second, auto-numbered migration.

For each target, reviewed DDL and its native `supabase_migrations.schema_migrations` insert executed in **one PostgreSQL transaction**. DB1's legacy `(version, inserted_at)` history shape was preserved. DB2/DB3's native `(version, statements, name)` layout received the exact version, migration name and source SQL with a checksum annotation. No history table was recreated, baselined, repaired or rewritten. This preserves the [CLI's version-based migration comparison](https://supabase.com/docs/guides/local-development/database-migrations); a later push sees these versions as already applied.

All three rollback-only dry-runs were verified to leave schema and history unchanged before production execution. Each production transaction used a five-second lock timeout, a sixty-second statement timeout, a transaction-scoped advisory lock, and guards against changes since preflight. Function definitions, grants/RLS, existing indexes, plan prices and all entitlements were compared before/after. Only the allowlisted migration was executed per target. DB1 was verified before DB2, and DB2 before DB3. No long-running transaction was detected during preflight.

The backup API reported no available completed backups and no PITR on these projects. No recovery configuration was changed. The migrations are additive; transaction failures roll back both DDL and history together. Successful production migrations were not automatically rolled back.

Two verifier issues were caught and corrected during execution: PostgreSQL normalizes RPC argument comma spacing, and the Management API's read-only database role cannot execute service-only functions. The former caused a rolled-back DB2 dry-run. The latter stopped the first run after DB1 committed and before either data shard was applied. Rejection probes were corrected to use the service role inside explicit **read-only transactions**, and rollout resumed after verifying DB1's already-applied version. No additional grants were introduced to make probes pass.

**Live verification versus isolated verification**

Live production inspection confirmed:

- DB1's two RPCs, `reserve_image_edit_usage` and `commit_image_edit_usage`, have the expected argument names/types, JSONB results, exact deployed function bodies, `SECURITY DEFINER`, and fixed `search_path=public, pg_temp`.
- DB2 and DB3 each have the five expected RPCs: claim, transition, prepare artifact, record artifact and complete edit. Their complete bodies and signatures match the TypeScript callers and canonical SQL independently.
- Each data shard has all five lineage columns, durable request storage, RLS, four foreign keys and four checks on `image_edit_requests`, its primary key, the unique edit-request image index, and the source-image index. Existing message uniqueness indexes remain unchanged.
- New RPCs reject actual `anon` and `authenticated` invocation attempts. Service-role invalid-identity calls are rejected before writes. DB1's Free-plan probe is also rejected before reservation or inference. All probes ran inside read-only transactions and created no customer charges, users or conversations.
- The service-role PostgREST OpenAPI contract exposes the deployed RPCs and shard request table after schema-cache notification. No paid inference was called.
- Existing control RPC definitions, existing grants/RLS and indexes, all plan prices and all entitlement JSON remained unchanged. Image allowances remain Free 2/24 hours; Essential 12/12 hours; Plus 20/12 hours; Pro 32/12 hours. Paid Klein edits cost 2 credits; Pro Intuitive verified Pollinations edits cost 8. Free editing remains denied.
- A final verification-only pass reported all three versions already applied and verified, with zero pending migrations. The sanitized machine-readable snapshot is [IMAGE_EDIT_MIGRATION_DEPLOYMENT.json](IMAGE_EDIT_MIGRATION_DEPLOYMENT.json).

Positive reserve/commit/release, expired-reservation recovery, paid model-cost validation, concurrent claims, artifact recovery, charge-once behavior and duplicate message/version prevention were exercised in isolated PostgreSQL/PGlite and mocked application tests. No paid customer operation or synthetic conversation was created in production to test positive paths. Independent multi-process image inference and live provider output quality remain unverified.

**Targeted code improvements in this follow-up**

| File | Concrete change |
| --- | --- |
| `scripts/deployImageEditMigrations.mjs` | New exact-target, exact-version deployer: independent credential/project/schema preflight, atomic DDL/history, rollback dry-run, failure-state reporting, exact body/signature/grant checks, safe role probes, PostgREST verification and historical-drift guard. Secrets remain in memory and headers. |
| `scripts/validateMigrationTracks.mjs` | Shared fail-closed validator derives counts from classified canonical files, checks manifest counters and hashes, verifies both track layouts, and rejects unexpected/missing files or scope changes. |
| `scripts/testImageEditDeployment.mjs` | Tests credential/identity rejection, count and checksum tampering, transaction/history layout compatibility, rollback of both schema and history on failure, and duplicate-apply prevention. |
| `scripts/nativeDataTrackBootstrap.mjs` | Removes the obsolete count of 68, validates the full manifest, restricts targets to DB2/DB3, removes `--include-all`, and replaces swallowed CLI-output parsing failures with exact read-only native-history verification. This bootstrap was not executed against production. |
| `scripts/baselineExistingProjects.mjs` | Replaces obsolete 22/64 counters with manifest-derived exact version sets. No baseline or repair action was executed. |
| `backend/testMigrationScopeSeparation.ts` | Derives global counts from scope entries and track membership, retaining checksum, scope and file identity assertions. Future additions do not require changing arbitrary numerical expectations. |
| `backend/testImagePolicyPass2.ts` | Reads the real `serverLegacy.ts` entry path and tests the current eight-cell Cloudflare/Pollinations routing matrix and current documentation instead of retired aliases/model chains. No production generation policy was changed. |
| `backend/services/imageEditingService.ts` | A stored result can finish recovery after a change between paid plans; its existing reservation still determines the actual model/cost. A fresh inference still requires matching authoritative plan resolution. |
| `backend/testImageEditing.ts` | Adds a regression for that paid-plan recovery case: no new inference and exactly one charge. |
| `scripts/testImageEditSql.mjs` | Adds real SQL rejection tests for null lease tokens, null status transitions and missing artifact size. |
| `supabase/migrations/20261024120000_paid_image_edit_ledger.sql` | Tightens null request/feature handling, requires a valid execution mode and uses null-safe feature comparison before deployment. |
| `supabase/migrations/20261024121000_image_edit_versions.sql` | Uses null-safe ownership/fingerprint/lease comparisons, rejects null status transitions and missing output size before deployment. These version files are now deployed and must not be edited for future changes. |
| `supabase/tracks/control/migrations/20261024120000_paid_image_edit_ledger.sql` | Regenerated byte-identical control copy. |
| `supabase/tracks/control/supabase/migrations/20261024120000_paid_image_edit_ledger.sql` | Regenerated byte-identical CLI control copy. |
| `supabase/tracks/data/migrations/20261024121000_image_edit_versions.sql` | Regenerated byte-identical data copy. |
| `supabase/tracks/data/supabase/migrations/20261024121000_image_edit_versions.sql` | Regenerated byte-identical CLI data copy. |
| `supabase/migration-manifest.json` | Updated checksums for the reviewed SQL; intended scopes and totals remain unchanged. |
| `package.json` | Adds the deployment contract test command. |
| `docs/PAID_IMAGE_EDITING_IMPLEMENTATION.md` | Adds a link to this production follow-up while preserving the original report as historical context. |
| `docs/IMAGE_EDIT_MIGRATION_DEPLOYMENT.json` | Sanitized final verification snapshot, including the separately diagnosed retirement drift. |
| `docs/IMAGE_EDIT_MIGRATION_DEPLOYMENT.md` | This report. |

The other original uncommitted implementation files were preserved; their complete inventory remains in the earlier implementation report. No `.env`, lockfile, workflow, unrelated provider, frontend layout or application deployment configuration was changed in this follow-up.

**Executed local checks**

| Check | Result |
| --- | --- |
| `npm.cmd run build` | PASS |
| `npm.cmd run test:image-editing` | PASS, 15 tests |
| `npm.cmd run billing:test-image-editing` | PASS |
| `npm.cmd run test:image-edit-sql` | PASS, 49 isolated PostgreSQL assertions |
| `npm.cmd run test:image-edit-deployment` | PASS, 4 tests including real PostgreSQL transaction rollback |
| `npm.cmd run test:migrations` | PASS, 12 checks |
| `backend/testImagePolicyPass2.ts` with the backend ts-node project | PASS after correcting obsolete expectations |
| `backend/billing/testQuota.ts` | PASS |
| `backend/billing/testGuestTextTrial.ts` | PASS |
| `backend/billing/testImageCreditsPolicy.ts` | PASS |
| `backend/testCloudflareImageArchitecture.ts` | PASS |
| `backend/testImageRoutingSafety.ts` | PASS |
| `backend/testPaidImageTextRouting.ts` | PASS |
| `backend/testIntuitiveImageRouting.ts` | PASS |
| `backend/testImagePersistence.ts` | PASS |
| `backend/testImageStorageService.ts` | PASS |
| `backend/testGenerationLeaseRetryRegression.ts` | PASS |
| `backend/testDurableGenerationScenarios.ts` | PASS |
| `backend/testGenerationCleanupContracts.ts` | PASS |
| `backend/testModelToolExecution.ts` | PASS |
| `backend/testModelToolTransport.ts` | PASS |
| `frontend/tests/canonical-image-merge.test.mjs` | PASS |
| `frontend/tests/image-deduplication.test.mjs` | PASS |
| Node syntax checks for deployment/bootstrap/baseline scripts | PASS |
| `git diff --check` | PASS |
| Changed-file scan for actual credential values; `.env` ignore check | PASS |

Source-relative TypeScript suites used `ts-node --project tsconfig.backend.json`. PGlite remained in the established temporary test directory; no dependency or lockfile change was needed. Destructive billing integration tests were not pointed at production. The legacy general startup verifier was not used for production probing because it can initialize synthetic users/conversations; production checks here use catalog inspection and explicit read-only role transactions.

**Operational security and remaining work**

No PAT, service-role key, database password, connection secret or `.env` content was disclosed, committed, uploaded or written to an authentication file. Network requests used project-specific credentials in headers. HTTP failures were reported through sanitized status codes; one diagnostic response was redacted before display. `.env` remains gitignored. Temporary schema-only snapshots contained no customer rows or authentication material. No commit or push was performed.

The image-edit database deployment is complete. The separate DB4-retirement constraint drift remains unresolved outside this two-version allowlist; the zero current DB4 mappings and runtime exclusion do not make that stale constraint correct. Backend application rollout is still separate and was not authorized here. Paid live-provider inference, true independent-worker load/fault testing and a dedicated editor UI remain outstanding. `erase_region` and `remove_background` remain explicitly unsupported (422 when otherwise valid); no additional paid provider or unverified capability was enabled.

Immutable staging objects can remain after a process crash or conversation deletion. A bounded reconciliation procedure should first audit at most 100 artifacts older than 24 hours, compare request leases/status, control reservation/usage state, object hash/path, and all image/message references, and retain every active, referenced, recoverable or charged artifact. Only conclusively failed, expired, uncharged, unreferenced output UUID paths belong in a later cleanup batch; original source paths are never candidates. No deletion job or unrelated infrastructure was introduced.
