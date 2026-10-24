Implementation report — 24 October 2026

Follow-up deployment status: the two image-edit migrations have now been applied and independently verified on production DB1, DB2 and DB3. The current validation results, targeted fixes and a separately discovered historical DB4-retirement constraint drift are recorded in [the deployment report](IMAGE_EDIT_MIGRATION_DEPLOYMENT.md). The original pre-deployment investigation and results below are retained as historical context.

The checkout was clean on `master`. `git log -1` and a live `git ls-remote origin refs/heads/master` both returned `66d8077e529a42e3be205d028ff86a9e386986a7`. Implementation is local and uncommitted; no live databases, deployment configuration, or live provider services were changed.

**Delivered behavior**

Authenticated `POST /api/images/edit` and automatic `image_gen` calls share the edit service. Free, guests, invalid identities, unauthorized sources, unresolved subscriptions, unsupported operations and invalid files fail before image inference. The server resolves the effective subscription twice, reserves credits through a paid-only control RPC, and checks the reservation plan. Callers cannot choose a model, cost, plan, storage path or source URL.

Example HTTP body:

```json
{
  "conversationId": "<owned conversation UUID>",
  "sourceImageId": "<owned chat_images UUID or latest>",
  "clientRequestId": "<new stable ID for this edit action>",
  "prompt": "Replace the background with a sunny garden",
  "operation": "replace_background",
  "executionMode": "fast",
  "size": "1024x1024"
}
```

Other accepted operation names are `edit`, `erase_region` and `remove_background`. The last two currently return `422 image_edit_operation_unsupported` when their required inputs are valid. Region erasing also requires a valid mask. Unsupported operations never reserve credits. `mask` accepts only a base64 PNG with source-matching dimensions, alpha, and both transparent edit pixels and opaque protected pixels. Masks on other operations are rejected.

Sources must already be stored in the owned conversation's `chat_images`; existing upload/store flows can materialize an uploaded source. `latest` binds to the original parent across retries. Input raster formats are PNG, JPEG and WebP, single-frame only, at most 8 MiB decoded file size and 16 megapixels. Source materialization uses server-owned Storage metadata and the configured Storage SDK, without arbitrary remote-image fetching. The existing text-to-image endpoint rejects edit-specific fields instead of silently discarding them.

**Verified provider contracts and limits**

| Plan/mode | Edit models, in order | Reserved / successful credits |
| --- | --- | --- |
| Essential, both modes | Cloudflare `@cf/black-forest-labs/flux-2-klein-4b` | 2 / 2 |
| Plus, both modes | Cloudflare `@cf/black-forest-labs/flux-2-klein-4b` | 2 / 2 |
| Pro Fast | Cloudflare `@cf/black-forest-labs/flux-2-klein-4b` | 2 / 2 |
| Pro Intuitive | Pollinations `openai/gpt-image-2`, then `microsoft/mai-image-2.6` | 8 / 8 |
| Free / guest | Denied | 0 |

Cloudflare edits send a binary PNG as multipart `input_image_0`; the adapter rotates and proportionally resizes the reference to at most 511 pixels per dimension. Output dimensions remain separate. This follows the [official Klein 4B reference-input contract](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/).

Pollinations edits use `POST /v1/images/edits`, a source data URL in JSON, a stable seed, `response_format: b64_json`, and bearer authentication. Redirects are rejected. The response must confirm the exact requested canonical ID in `x-model-used`; changed/missing model identity is rejected. Contract verification used Pollinations commit `d355e8a03c3bed155e9408804198a798990543c6`: [model capabilities](https://github.com/pollinations/pollinations/blob/d355e8a03c3bed155e9408804198a798990543c6/shared/registry/image.ts) and [edit endpoint implementation](https://github.com/pollinations/pollinations/blob/d355e8a03c3bed155e9408804198a798990543c6/gen.pollinations.ai/src/routes/images.ts). Aliases and `black-forest-labs/flux.1.1-pro` are excluded from edits. The latter remains in the unchanged text-to-image generation matrix.

These are documentation/source-verified and provider-mocked capabilities, not paid live-inference certification. The verified existing model set exposes neither a mask contract through these adapters nor verified transparent background removal. No additional provider/model was introduced to fill that gap. Background replacement is reference-conditioned generative editing; it cannot guarantee unchanged foreground pixels or segmentation accuracy. MAI's upstream edit implementation does not forward width/height, so requested size is not guaranteed for that fallback.

**Credits, identity and recovery**

Existing allowances remain Free 2 credits/24 hours, Essential 12/12 hours, Plus 20/12 hours, and Pro 32/12 hours. Generation costs, default generation fallback chains, text billing, provider policies and the five-second success cooldown are unchanged. Cooldown admission for edits reserves nothing, remains retryable with the same ID, and completed replays do not restart cooldown.

A hash of user, conversation and client request ID identifies the edit. A separate fingerprint binds prompt, operation, source bytes, mask bytes, size and mode. Conflicting reuse returns 409. The shard claim serializes workers, the control reservation and usage event are idempotent, output uses one immutable object/image UUID, and a shard transaction creates the version metadata and later completes the user/assistant messages under existing request uniqueness constraints. Original files are never overwritten or removed by editing. `chat_images` exposes parent lineage, operation metadata, request identity and content hash.

The durable states are claimed → invoking → storing → generated → completed, with terminal failed requests. The intended artifact hash/path is checkpointed before upload. A retry can verify an uploaded artifact, checkpoint it, settle the actual successful model cost once, and complete messages without inference. Lost checkpoint, settlement and completion responses are covered. Known failed/aborted inference releases its reservation. An ambiguous failure after output preparation retains recovery state rather than risking a second invocation or undoing a committed charge.

Queue, abort propagation, account pools and provider cooldowns use the existing router. Image model work has a five-minute bound, shard claims a ten-minute lease, and edit reservations a one-hour TTL. An expired reservation must re-acquire available quota before late recovery can settle; tests verify that this cannot exceed the quota ceiling. An expired `invoking` request without a stored checkpoint becomes terminal instead of re-invoking the provider. Its reservation is released on retry, or stops counting on expiry.

**Migration requirements**

Apply both new migrations before releasing backend code, since image-list queries also expose the added lineage columns.

| Database | Migration | Contents |
| --- | --- | --- |
| Control DB1 only | `20261024120000_paid_image_edit_ledger.sql` | Paid-only reservation and validated model-cost settlement wrappers; existing generation RPCs and plan rows are unchanged |
| Data shards DB2 and DB3 only | `20261024121000_image_edit_versions.sql` | Version columns, durable edit records, ownership/lease/artifact/message RPCs and service-role-only permissions |

The manifest and both copies of each track were regenerated: 85 canonical migrations, 25 control-track migrations, 69 data-track migrations. No migration targets retired DB4. Both new SQL files were applied twice in isolated PostgreSQL to check idempotency. No live migration was applied.

**Validation results**

| Check | Result |
| --- | --- |
| `npm.cmd run build` | PASS |
| `npm.cmd run test:image-editing` | PASS, 14 functional/provider/storage/recovery tests |
| `npm.cmd run billing:test-image-editing` | PASS, reservation/settlement/release adapter checks |
| `npm.cmd run test:image-edit-sql` | PASS, 46 real PL/pgSQL assertions in temporary PGlite PostgreSQL |
| `npm.cmd run test:migrations` | PASS, 12 checks including manifest checksums, track scopes and credential separation |
| `backend/testCloudflareImageArchitecture.ts` | PASS; malformed PNG fixture replaced with generated valid PNG after a libspng failure |
| `backend/testImagePersistence.ts` | PASS |
| `backend/testImageStorageService.ts` | PASS |
| `backend/testImageRoutingSafety.ts` | PASS |
| `backend/testPaidImageTextRouting.ts` | PASS |
| `backend/testIntuitiveImageRouting.ts` | PASS |
| `backend/billing/testImageCreditsPolicy.ts` | PASS |
| `backend/billing/testQuota.ts` | PASS |
| `backend/billing/testGuestTextTrial.ts` | PASS |
| `backend/testToolContract.ts` | PASS |
| `backend/testModelToolExecution.ts` | PASS |
| `backend/testModelToolTransport.ts` | PASS |
| `backend/testGenerationLeaseRetryRegression.ts` | PASS |
| `frontend/tests/canonical-image-merge.test.mjs` | PASS |
| `frontend/tests/image-deduplication.test.mjs` | PASS |
| `git diff --check` | PASS |

Existing TypeScript regression suites were run using `ts-node --project tsconfig.backend.json`; several read repository source relative to `__dirname` and cannot be run from compiled `dist` without copying source files. Initial compiled-test invocations failed for that harness reason and were rerun correctly.

`backend/testImagePolicyPass2.ts` was also attempted and fails on a pre-existing stale assertion: it reads `server.ts` for a route now in `serverLegacy.ts`, and asserts the retired Pollinations model matrix. It was not rewritten to conceal the historical policy mismatch; the current eight-cell generation matrix is covered by the passing Cloudflare and billing suites.

`backend/billing/testImagePlanPolicyMigration.ts` passed its static SQL assertions, then could not run its integration section: it requires `psql`, a disposable `SENTIQ_BILLING_TEST_DATABASE_URL` and `SENTIQ_BILLING_TEST_DATABASE_ALLOW_DESTRUCTIVE=true`. No disposable URL was configured. `backend/billing/testImageCreditsDatabaseIntegration.ts`, `check:migrations`, and paid live-provider/Storage/JWT end-to-end checks require appropriately migrated staging services and credentials and were not run against production. The new SQL was instead exercised against isolated PostgreSQL fixtures using the actual existing reserve/commit/release functions plus both new migrations. PGlite was installed only in a temporary directory; project dependencies and lockfiles were not changed.

To repeat isolated SQL tests, install `@electric-sql/pglite@0.3.14` in a temporary directory, set `SENTIQ_TEST_PGLITE_MODULE` to its `dist/index.js`, then run `npm.cmd run test:image-edit-sql`.

**Remaining rollout risks**

- Region erasing and transparent background removal remain explicitly unavailable with the currently verified providers. Enabling either requires a verified compatible contract and approval for any additional paid provider/model.
- Run paid staging inference, authentication/ownership, real Supabase Storage, and independent multi-instance concurrency checks before production release. Local PostgreSQL function tests are not a substitute for network-fault/load testing across real services.
- External providers do not guarantee billing idempotency. Normal account/model fallback attempts retain the existing routing policy; stable seeds do not guarantee one upstream execution. A crash during inference with no confirmed artifact intentionally requires a new action ID after recovery rather than replaying inference automatically.
- Recovery is driven by a replay of the same request or normal chat generation recovery, without new background/deployment infrastructure. Unreplayed interrupted requests can retain a reservation until its TTL. Conversation deletion or a crash around a storage write may leave an immutable staging object that needs operational reconciliation; the source image remains untouched.
- The existing public image bucket, one-MiB object limit and process-local cooldown/queue remain. Transparency-preserving compression rejects objects still over the limit. No dedicated editor UI or client retry scheduler was added; the backend endpoint and existing automatic image tool are the integration surfaces.

**All changed and added files**

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
backend/testMigrationScopeSeparation.ts
backend/tools/imageGeneration/imageEditPolicy.ts
backend/tools/imageGeneration/imageEditValidation.ts
backend/tools/imageGeneration/imageRouter.ts
backend/tools/imageGeneration/imageStorageService.ts
backend/tools/imageGeneration/providers/cloudflareImageProvider.ts
backend/tools/imageGeneration/providers/pollinationsImageModelProvider.ts
backend/tools/imageGeneration/types.ts
backend/validation/schemas.ts
docs/PAID_IMAGE_EDITING_IMPLEMENTATION.md
package.json
scripts/generateMigrationTracks.mjs
scripts/testImageEditSql.mjs
supabase/migration-manifest.json
supabase/migrations/20261024120000_paid_image_edit_ledger.sql
supabase/migrations/20261024121000_image_edit_versions.sql
supabase/tracks/control/migrations/20261024120000_paid_image_edit_ledger.sql
supabase/tracks/control/supabase/migrations/20261024120000_paid_image_edit_ledger.sql
supabase/tracks/data/migrations/20261024121000_image_edit_versions.sql
supabase/tracks/data/supabase/migrations/20261024121000_image_edit_versions.sql
```
