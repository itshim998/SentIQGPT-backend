# Live image edit verification and annotation contracts

Branch `feature/paid-image-editing-backend-review`, draft PR #93. The clean working tree was fast-forwarded from `fbd86af7d0105fb934967cf362f620de3f12fef2` to remote `fdd2aedb0dbca395e29124fb7db01876d25348d9` before changes. ChatGPT's editor, styling, local PNG download, history, focus handling and chat integration are retained and extended. No production application or database deployment occurred in this task.

## Authenticated provider results

Exactly four direct inference attempts used a synthetic 256x256 white image with a red rectangle and blue circle. The instruction changed only the rectangle to green. Each request asked for one output with a fixed seed; Pollinations used low quality. No router, account rotation, automatic retry, customer source, SentIQ reservation or customer credit was involved. All four results were decoded, hashed and visually inspected: each preserved the layout/blue circle and produced a green rectangle.

| Exact model | Input actually called | HTTP/output | Identity metadata |
| --- | --- | --- | --- |
| `@cf/black-forest-labs/flux-2-klein-4b` | Multipart binary `input_image_0`, 256px reference and output request | 200, JSON `result.image`, JPEG 256x256 | Fixed model URL; no model response header |
| `openai/gpt-image-2` | JSON inline PNG data URL | 200, JSON `data[0].b64_json`, JPEG 816x816 despite 512x512 request | Exact canonical `x-model-used` and `x-model-requested`; no fallback target |
| `openai/gpt-image-2` | Multipart PNG file | 200, same envelope, JPEG 816x816 | Same canonical headers; no fallback target |
| `microsoft/mai-image-2.6` | Multipart PNG file | 200, same envelope, JPEG 1024x1024 despite 512x512 request | Exact canonical headers; no fallback target |

One additional authenticated JSON request omitted the required image and returned HTTP 400, as expected before inference. There were no retries of that request. Failure modes such as timeout, missing/mismatched model metadata, Storage faults and concurrent application retries were mocked or isolated locally; they were not induced through additional paid calls.

The existing JSON adapter was **not defective in the verified GPT call**. Current official Pollinations route code explicitly parses both JSON and multipart, normalizing both to the same image-aware request. The MAI JSON path is covered by this shared official parser and the application's existing adapter contract; it was not separately called live in this four-inference budget. The adapters and strict canonical-ID checks remain unchanged because all observed Pollinations responses supplied the expected canonical identity. Missing or changed identity remains an ambiguous failure, preventing incorrect settlement under the requested model. No new fallback model was allowed.

Equivalent GPT JSON/multipart requests with the same seed produced different output hashes. A stable seed is not upstream idempotency. Actual output dimensions may exceed the requested small size; mocked tests cover the observed JPEG/envelope/dimension behavior. The live tests establish direct provider contracts, not a full SentIQ JWT/billing/Storage or editor end-to-end release test. Background replacement, annotation-guidance semantics and native masks were not separately invoked live.

[Sanitized live results](IMAGE_EDIT_LIVE_PROVIDER_RESULTS.json) record HTTP status, exact models, numeric usage, output dimensions, byte counts, SHA-256, timing and source hash. Synthetic artifacts were inspected from a temporary directory and are not committed. `scripts/verifyImageEditProvidersLive.mjs` requires `--run`, refuses an existing report and performs at most four inference attempts with no retry. Do not remove the report and rerun it without deciding a new cost budget.

### Provider costs

Reported usage for each GPT call: 23 text-input tokens, 256 image-input tokens, 171 image-output tokens. MAI reported 64 image-input and 1024 image-output tokens. Cloudflare processed one small reference/output tile. Published-rate arithmetic estimates approximately **USD 0.04085** with the Pollinations registry's 0.75 multiplier, or **USD 0.05436** at its unmultiplied base rates including Cloudflare's tile estimate. These are estimates, not measured account debits or an invoice. Actual charges were not supplied by the response headers, and free allocations/discounts/caching were not independently reconciled. The calls may consume the configured provider account's balance/allocation; **zero SentIQ customer generation credits** were reserved or consumed.

Primary sources checked:

- [Pollinations edit route, pinned official source](https://github.com/pollinations/pollinations/blob/152962821cf7df4592e4b06b3153bcb1b76038a4/gen.pollinations.ai/src/routes/images.ts) and [exact model registry/prices](https://github.com/pollinations/pollinations/blob/152962821cf7df4592e4b06b3153bcb1b76038a4/shared/registry/image.ts).
- [Official multipart examples](https://github.com/pollinations/pollinations/blob/152962821cf7df4592e4b06b3153bcb1b76038a4/gen.pollinations.ai/src/docs/apidocs-recipes.md).
- [Cloudflare Klein reference contract](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/) and [tile pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- [Cloudflare Bria background removal](https://developers.cloudflare.com/ai/models/bria/remove-background/): separate third-party service at USD 0.018/image, with temporary PNG result URLs. It was neither enabled nor called. No credit weight or URL-fetch exception was introduced.

## Server contracts

All editing and saving requires authenticated, effective Essential/Plus/Pro entitlement, even though annotation saving uses zero generation credits. Free and guests remain excluded. Client plans, models, costs, source URLs, raw image files, SVG and Storage paths are not accepted.

`GET /api/images/editor-capabilities` returns paid-user capability flags. `annotationSave` is true only when the user's data shard reports annotation schema version `20261024190000`. If this new migration is absent or the capability request fails, the frontend leaves save/guidance unavailable as appropriate while preserving local drawing/download. `annotationForAi` indicates support in the running backend code, independently of the non-generative migration. Erasing and background removal remain false.

`POST /api/images/annotations` takes only:

```json
{
  "conversationId": "<owned conversation UUID>",
  "sourceImageId": "<owned saved image UUID>",
  "clientRequestId": "<stable unique ID for this save>",
  "annotation": {
    "version": 1,
    "strokes": [
      { "color": "#00ff00", "size": 6, "points": [{ "x": 0.3, "y": 0.4 }, { "x": 0.6, "y": 0.5 }] }
    ]
  }
}
```

The format is strict: 1–128 strokes, at most 4096 total points, finite normalized coordinates in [0,1], six-digit hex colors and integer brush sizes 2–25. No prompt or generation mode exists on this endpoint. Points are rendered over server-loaded, owned source bytes through numeric-only generated SVG and Sharp. Pixel bounds, decode validation, orientation, alpha handling and immutable one-MiB Storage limits are reused. At most two annotation rasterizations run per process; excess work gets retryable admission control. The existing authenticated rate limiter also applies.

The service has no reservation, settlement, inference, image quota or cooldown dependency. Its successful response includes normal image/message/version identifiers, `operation: "annotate"` and `generation_credits_used: 0`. The existing chat refresh callback does not alter generation cooldown or quotas for these responses.

`POST /api/images/edit` additionally accepts the same optional `annotation` object for `edit` and `replace_background`. The backend composites it into the owned reference image bytes before routing. The model receives pixels containing visual guidance, not textual coordinates. Instructions ask it to use and remove the guide marks. The original source hash plus normalized annotation are bound into the existing durable fingerprint; changed marks conflict with reuse of the same request ID. Source-less checkpoint recovery retains that identity. Existing unannotated request fingerprints remain unchanged. Klein still reserves/settles 2 credits; Pro Intuitive still uses the exact existing 8-credit model family and settlement policy.

The editor offers separate “Save drawing to chat”, “Use drawing for AI” and local PNG-download actions, with separate stable request IDs. AI guidance is opt-in and its presence appears with the AI credit display. Version history retains parent IDs from trusted metadata when the FK is cleared by source deletion, including sibling grouping under missing parents. Persisted immediate lineage survives deletion; deleted versions themselves are not restored or exposed.

## Persistence, recovery and migration

New forward-only migration: **`20261024190000_image_annotation_versions.sql`, DATA_ONLY for DB2 and DB3**. It adds a service-only/RLS-protected annotation-request ledger, identity/lease/checkpoint/completion RPCs, supporting indexes and a schema-version RPC. It adds no control-database schema or billing policy. Both data track copies and the manifest are regenerated: **88 canonical, 26 control, 71 data**. The migration is **not applied** in this task and must precede backend enablement of server-side annotation saving. It must never run on DB1 or retired DB4.

Request identity binds user, conversation and client ID, with a separate `image-annotation:` namespace. Fresh saves require the owned source row and bytes. A stored checkpoint can recover after parent deletion using retained trusted metadata and verified immutable object bytes. A missing staging object may be recreated only from the same still-owned, hash-matching source and exact prepared artifact. Completed output/message/object deletion is terminal for replay; completed versions are never recreated. Row locks, leases and a single shard completion transaction produce one image row and assistant message, including after lost responses. Competing/generative assistant-image client IDs cannot silently collide. Conversation/user deletion cascades annotation requests; source deletion clears its FK while retaining identity in metadata.

Existing Storage boundaries and cleanup behavior are reused. Normal image/conversation cleanup sees annotation `chat_images` rows. Unpublished staging objects can still remain after a crash or deletion; this task does not add a destructive reconciliation job. Retain active/referenced/recoverable artifacts and use a separately reviewed cleanup procedure. No already-applied migration was edited or replayed.

## Validation and rollout limits

All **22 applicable local checks passed**; [exact commands/results](IMAGE_EDITOR_ADVANCED_TEST_RESULTS.json). They include build, 23 edit/provider tests, 6 new annotation tests, image billing, 84 existing plus 54 annotation PostgreSQL assertions, migration validation, both deployment-contract suites, generation routing/policy, quota, persistence/Storage, lease/crash recovery, editor tests and the 11-gate frontend aggregate. SQL used the existing temporary PGlite engine; dependencies/lockfiles were not changed. No live inference is part of automated regression suites.

Tests cover actual composited pixels and alpha/orientation, bounded render concurrency, invalid drawing/file/URL/SVG input, paid-only ownership, zero credit calls, unchanged generative pricing, changed guidance identity, incomplete source-deletion recovery, lost checkpoint/completion responses, missing/corrupt artifacts, concurrent saves, explicit deletion tombstones, source provenance, message conflicts, permissions, scope and DDL/native-history rollback. The renderer/UI contract was exercised through local unit/integration helpers; a real browser authenticated editor session and multi-worker Supabase/Storage fault test remain required. PGlite executes the real functions but serializes connections, so it is not proof of independent-worker behavior.

Only one consolidated feature-branch push is intended after local validation; no workflow dispatch/rerun, master push, merge, infrastructure edit or production application deployment is part of this task. The PR remains draft for independent review. Release blockers include applying the new DATA_ONLY migration through reviewed deployment, staging JWT/Storage/editor end-to-end checks, live guidance quality checks within a separately chosen budget, and multi-instance/reconciliation testing. Native mask erasing and transparent background removal remain unavailable. Published reference-image support is not native mask support.

## Complete changed-file inventory

```text
backend/serverLegacy.ts
backend/services/imageAnnotationService.ts
backend/services/imageEditingService.ts
backend/testImageAnnotations.ts
backend/testImageEditing.ts
backend/tools/imageGeneration/imageAnnotationContract.ts
backend/tools/imageGeneration/imageAnnotationRenderer.ts
backend/tools/imageGeneration/imageEditValidation.ts
backend/tools/imageGeneration/imageStorageService.ts
docs/ADVANCED_IMAGE_EDITOR_HANDOFF.md
docs/IMAGE_EDITOR_ADVANCED_TEST_RESULTS.json
docs/IMAGE_EDIT_LIVE_PROVIDER_RESULTS.json
frontend/scripts/features/image-editor.js
frontend/scripts/services/api.js
frontend/tests/paid-image-editor.test.mjs
package.json
scripts/generateMigrationTracks.mjs
scripts/testImageAnnotationSql.mjs
scripts/verifyImageEditProvidersLive.mjs
supabase/migration-manifest.json
supabase/migrations/20261024190000_image_annotation_versions.sql
supabase/tracks/data/migrations/20261024190000_image_annotation_versions.sql
supabase/tracks/data/supabase/migrations/20261024190000_image_annotation_versions.sql
```
