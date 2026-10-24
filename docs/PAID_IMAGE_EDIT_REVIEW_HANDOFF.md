# Paid image editing: independent backend review handoff

Review branch: `feature/paid-image-editing-backend-review`, based on master `66d8077e529a42e3be205d028ff86a9e386986a7`. This is a backend review candidate, not a production-readiness declaration. The commit containing this document is the review commit; its SHA and draft PR URL are in the final handoff and GitHub metadata.

## Behavior and audit findings

Essential, Plus and Pro use server-resolved paid entitlement and owned, stored conversation images through the shared HTTP/tool executor. Free and guest edits fail before inference or credit reservation. Existing generation routing, paid quotas and text billing remain unchanged. Edit chains allow only Cloudflare FLUX.2 Klein 4B and the exact Pollinations IDs `openai/gpt-image-2` and `microsoft/mai-image-2.6`, subject to plan/mode policy. Provider contracts are covered by mocked tests, not live inference verification.

Cloudflare uses multipart binary `input_image_0` resized below 512 pixels on each side. Pollinations uses authenticated JSON/data-URL requests and verifies the returned model identity. Text-only fallback models are excluded from editing. General edits and background replacement are supported. Valid region-erasing and background-removal requests explicitly return unsupported-operation errors; malformed files/masks are rejected earlier. Storage preserves alpha and rejects oversized artifacts instead of flattening transparency.

Credit reservations precede inference and cover the maximum allowed model cost; settlement uses the successful model's weighted cost once. Failure release and repeated settlement are covered by ledger tests and isolated PostgreSQL tests against the actual RPC definitions. Durable shard requests, leases, artifact checkpoints, control-ledger identity and atomic message completion prevent duplicate persistent versions/messages and charges across tested retries. Existing generation queue/cooldown behavior is reused. Cross-service failure recovery depends on replay, TTLs and immutable artifacts rather than a new transaction coordinator.

This final audit reproduced and fixed completed replay failing after deletion of the original source file. Completed requests now verify their stored fingerprint and current paid entitlement/conversation ownership before returning the stored result, without reading the parent bytes, reserving again or invoking a model. The regression proves unchanged output identity, one charge/invocation, changed-input rejection, ownership enforcement and Free exclusion. Pending recovery can still require the parent source; this fix does not alter deployed SQL.

Earlier follow-up corrections retained here include NULL-safe SQL lease checks, stored-result recovery across paid-plan changes, deployment verification of function bodies/ACLs/native history, dynamic migration counts and removal of unsafe blanket bootstrap application. The legacy Pass2 routing test now checks the actual route file and current model policy; its obsolete failure in the initial implementation report is superseded by the passing final run.

## Validation

All 23 top-level local checks passed. Exact commands/results are recorded in [IMAGE_EDIT_REVIEW_TEST_RESULTS.json](IMAGE_EDIT_REVIEW_TEST_RESULTS.json). Build and the image-editing suite were rerun after the completed-replay fix: build passed, 16 tests passed, zero failures/skips. SQL tests passed 49 isolated assertions; deployment contracts passed 4 tests without skips; migration validation passed 12 checks; recovery suites passed 9 and 17 tests. The frontend aggregate passed all 11 gates. Other existing routing, persistence, Storage, quota, guest/text billing and tool suites all passed. `git diff --check` is a final commit gate.

Source-relative TypeScript regressions use `ts-node --project tsconfig.backend.json`. Isolated SQL/deployment tests use the temporary PGlite module through `SENTIQ_TEST_PGLITE_MODULE`; no dependency or lockfile was added. PowerShell blocks `npm.ps1` locally, so commands were executed with `npm.cmd` or Node's npm CLI entry point. An intermediate TypeScript mismatch introduced during the replay fix was corrected before the passing build/test reruns.

Live provider inference, staging JWT/Storage end-to-end validation, multi-worker network-fault/load tests, and destructive billing integration suites requiring a disposable PostgreSQL URL were not executed against production. The original implementation report explains those credential-dependent suites. No coverage was removed to mask failures.

## Immutable SQL and deployment safety

The two image-edit versions were applied during the earlier migration task. No production database operation, migration replay, additional migration or application deployment occurred during this final review task. Historical deployment reports remain a record of that earlier task.

| Canonical SQL | SHA-256 of deployed bytes |
| --- | --- |
| `supabase/migrations/20261024120000_paid_image_edit_ledger.sql` | `1d593d41c9f082de622a131a54ffb940e401530c3fb58686bbd6ad5a44bee289` |
| `supabase/migrations/20261024121000_image_edit_versions.sql` | `0d7cd7cf1d44575f7f97559242db141d7cb00b399fd9a02c0ecbbd5c36f95afd` |

Both canonical files and all four track copies remain byte-identical to these hashes. Control/data scope remains 25/69 migrations, 85 canonical versions. The feature branch adds no DB4 migration; see [the separate proposal](DB4_CONSTRAINT_REPAIR_PROPOSAL.md). The pre-existing DB1 constraint allowing DB4 remains unresolved.

Existing workflow definitions were inspected and remain unchanged. Azure production rollout is triggered by master pushes or explicit dispatch, not this feature push or draft PR. Supabase production jobs require master and a non-PR event; PR validation remains eligible. No workflow dispatch, merge or master push is authorized by this handoff. `.env`, credential values, lockfiles and build artifacts are excluded from the commit.

## Remaining rollout risks

- Provider availability, entitlement, exact model response headers and inference quality need live paid staging verification. Mocked contract compatibility does not establish production reliability.
- Erasing and transparent background removal remain unavailable; no new paid provider or unverified model capability was added.
- No dedicated editor UI or client retry scheduler is included. The endpoint and automatic tool are integration surfaces.
- Provider-side exactly-once inference is not guaranteed. A crash during an uncertain invocation can require a new action ID; stored artifact replay avoids re-inference. The public image bucket, one-MiB limit and process-local queue/cooldown remain existing constraints.
- Parent deletion during incomplete recovery, orphaned staging objects, reservation expiry and independent-worker failures need staging/operational review. No automatic destructive cleanup was introduced.
- DB4 constraint drift requires the separate, approved forward-only repair. Do not replay the historical retirement migration or modify already-deployed image-edit SQL.

## Complete changed-file inventory

The following inventory includes implementation, tests, immutable migration additions, tooling and sanitized review/deployment records. No workflow, frontend implementation, `.env` or lockfile changes are included.

```text
backend/billing/billingRepository.ts
backend/billing/quotaService.ts
backend/billing/testImageEditCredits.ts
backend/orchestrator/toolContract.ts
backend/orchestrator/toolExecutor.ts
backend/serverLegacy.ts
backend/services/generatedImagePersistenceService.ts
backend/services/imageEditingService.ts
backend/testCloudflareImageArchitecture.ts
backend/testImageEditing.ts
backend/testImagePolicyPass2.ts
backend/testMigrationScopeSeparation.ts
backend/tools/imageGeneration/imageEditPolicy.ts
backend/tools/imageGeneration/imageEditValidation.ts
backend/tools/imageGeneration/imageRouter.ts
backend/tools/imageGeneration/imageStorageService.ts
backend/tools/imageGeneration/providers/cloudflareImageProvider.ts
backend/tools/imageGeneration/providers/pollinationsImageModelProvider.ts
backend/tools/imageGeneration/types.ts
backend/validation/schemas.ts
docs/DB4_CONSTRAINT_REPAIR_PROPOSAL.md
docs/IMAGE_EDIT_MIGRATION_DEPLOYMENT.json
docs/IMAGE_EDIT_MIGRATION_DEPLOYMENT.md
docs/IMAGE_EDIT_REVIEW_TEST_RESULTS.json
docs/PAID_IMAGE_EDITING_IMPLEMENTATION.md
docs/PAID_IMAGE_EDIT_REVIEW_HANDOFF.md
package.json
scripts/baselineExistingProjects.mjs
scripts/deployImageEditMigrations.mjs
scripts/generateMigrationTracks.mjs
scripts/nativeDataTrackBootstrap.mjs
scripts/testImageEditDeployment.mjs
scripts/testImageEditSql.mjs
scripts/validateMigrationTracks.mjs
supabase/migration-manifest.json
supabase/migrations/20261024120000_paid_image_edit_ledger.sql
supabase/migrations/20261024121000_image_edit_versions.sql
supabase/tracks/control/migrations/20261024120000_paid_image_edit_ledger.sql
supabase/tracks/control/supabase/migrations/20261024120000_paid_image_edit_ledger.sql
supabase/tracks/data/migrations/20261024121000_image_edit_versions.sql
supabase/tracks/data/supabase/migrations/20261024121000_image_edit_versions.sql
```
