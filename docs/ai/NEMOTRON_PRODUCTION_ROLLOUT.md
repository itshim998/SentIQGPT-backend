# Nemotron production rollout

The production workflow uses the Azure Container Apps revision API as a
blue/green deployment. It never renders an update document from
`az containerapp show`, because management-plane responses can omit plain
environment values and can represent a valid secret-backed variable with an
empty `value`.

## Safety invariants

- The rollback source is `latestReadyRevisionName`, never
  `latestRevisionName`.
- The source revision must be provisioned, healthy, active, running a replica,
  use the expected immutable image and container, and pass `/ready`.
- Critical runtime configuration is checked inside the source replica. The
  checker emits variable names and booleans only.
- Existing Pollinations, Supabase, and internal-service-token secret
  references are reused. `SUPABASE_URL_1` is restored to the existing
  `supabase-url-1` reference when Azure returns only redacted metadata.
- Missing NVIDIA slots and the anonymous-usage hash secret are created only
  after every non-mutating preflight and image-packaging check passes. Secret
  values are never written to disk or uploaded.
- `az containerapp revision copy --from-revision` preserves unspecified
  environment variables, probes, identity, registry, ingress, and scaling.
  Only the immutable image and explicit rollout variables are overridden.
- Production is changed to multiple-revision mode and pinned to the proven
  source revision before the new revision is created. The new revision receives
  zero traffic until readiness, runtime, database, provider, billing, context,
  WebSurf, cancellation, and leakage checks all pass.
- Activation is an explicit traffic change. The previous healthy revision
  remains active at zero traffic for emergency rollback.
- Any post-copy failure creates a new revision copied exactly from the proven
  source, without image or environment overrides. This is necessary because
  Azure's `latestReadyRevisionName` is monotonic and cannot be moved backward
  merely by changing traffic. The workflow verifies the rollback copy at zero
  traffic, activates it at 100%, deactivates the failed revision, retains
  multiple-revision mode and the original source, verifies `/ready`, and only
  then returns workflow failure.
- Independent NVIDIA slot verification retries only bounded, explicitly
  retryable upstream conditions (`empty_stream`, rate limiting, and transient
  transport errors). Authentication, malformed output, and public reasoning
  markers fail immediately.

Both Azure deployment workflows use the
`azure-container-apps-production` concurrency group. While blue/green mode is
active, the ordinary master deployment exits successfully without deploying so
it cannot overwrite a verified full-rollout environment.

## Azure identity prerequisite

The GitHub deployment identity needs:

- `Container Apps Contributor` on the production resource group; and
- `Managed Identity Operator` scoped only to the user-assigned identity used
  by the Container App for registry pulls.

The second permission is required because Container App secret and revision
writes revalidate the linked registry identity. Broader subscription-level
identity permissions are not required.

## Evidence

Every run creates `nemotron-rollout-summary.json` before Azure preflight.
Successful runs add redacted Azure, runtime, readiness, NVIDIA, Pollinations,
and end-to-end reports. Early failures still upload the summary without
missing-artifact warnings. Runner-temporary Azure metadata is permission
restricted, never uploaded, and deleted in the final cleanup step.
