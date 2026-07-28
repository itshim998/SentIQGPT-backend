# Pass 6 — Frontend quota UX and visible Fast handling

## Scope

Pass 6 connects the flagged Free unified text-token policy to the existing SentIQ Chat frontend without enabling the rollout by default.

The frontend experience is active only when the backend returns `quota_ui_enabled: true`. The backend exposes that value only when both of these flags are enabled:

- `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED`
- `SENTIQ_INTUITIVE_QUOTA_UI_ENABLED`

Tracked defaults remain `false`.

## User-visible states

### Available

The composer shows the total remaining text tokens and the amount currently usable by Intuitive. Fast remains able to use the full remaining balance.

### Fast only

When Intuitive cannot satisfy its safe minimum without entering the protected final 10,000 tokens, the interface:

- makes Intuitive unavailable in the mode menu;
- visibly changes the selected mode to Fast when necessary;
- explains that Fast remains available;
- shows a dynamic recovery countdown derived from `next_recovery_at`.

The backend still never silently changes execution mode. The browser performs the visible change before retrying.

### Exhausted

When the remaining balance cannot satisfy the minimum meaningful Fast request, the interface:

- preserves the composer draft;
- blocks submission and mode actions;
- marks the composer inert and read-only;
- shows `Text limit reached` and the dynamic recovery countdown;
- automatically refreshes the quota state as capacity returns.

No fixed reset time is invented.

## One-time Intuitive → Fast retry

The API wrapper handles only these structured Intuitive quota results:

- `intuitive_fast_required`
- `unified_text_insufficient_for_request`

When the quota UI rollout is enabled and Fast still has a meaningful reservation available, the wrapper:

1. suppresses the first quota error from the conversation surface;
2. visibly switches the mode control to Fast;
3. shows `Switched to Fast to protect your remaining tokens.`;
4. retries the same request once in Fast;
5. preserves the original client request ID and existing composer/conversation state.

The retry marker prevents loops. Exhaustion, service unavailability, provider failure, and unrelated errors are never retried as Fast.

## Refresh model

Quota state refreshes:

- at startup;
- after successful chat settlement;
- after billing-panel updates;
- after authentication changes;
- when the browser returns online or regains focus;
- once per minute while the page remains open.

The visible countdown updates once per second without issuing a request each second.

## Billing panel

Free V2 users with the quota UI flag enabled see one unified `Text tokens` meter rather than separate Standard and Lite meters. It includes:

- total remaining tokens;
- Fast-available tokens;
- Intuitive-available tokens;
- the 10,000-token protected Fast reserve;
- recovery guidance when Intuitive or the full composer is unavailable.

Paid plans and flag-off operation retain the existing Standard/Lite presentation.

## Guest and authenticated sessions

The quota controller uses `/api/billing/usage`, which already resolves authenticated users and hashed guest identities. No user ID or guest hash is stored in frontend quota state or displayed in diagnostics.

The account Billing panel remains signed-in-only, while the composer quota state works for both guest and authenticated sessions.

## Accessibility

- Quota text uses a polite live region.
- Unavailable Intuitive mode receives `aria-disabled=true`.
- Exhausted composer state receives `aria-disabled=true` and `inert`.
- Draft text is retained rather than cleared.
- Independent composer locks are preserved when quota capacity returns.
- Forced-colour and reduced-motion fallbacks are included.
- The status is text-based and does not rely on coloured dots.

## Public safety

The quota UI does not expose provider names, model names, hidden reasoning, internal routing, identity values, or raw billing rows.

## Tests

Pass 6 adds:

- `backend/billing/testQuotaUiExposure.ts`
- `frontend/tests/text-quota-state.test.mjs`
- `frontend/tests/text-quota-controller-contract.test.mjs`
- `frontend/tests/text-quota-controller-runtime.test.mjs`
- `npm run test:quota-ui-contract`

The focused tests cover:

- independent rollout-flag combinations;
- fresh, reserve-boundary, one-token-headroom, heavy-context, low-Fast, and exhausted states;
- an executable Intuitive rejection followed by exactly one successful Fast retry;
- suppression of the first quota error from the conversation surface;
- no Fast retry on complete exhaustion;
- composer draft preservation and blocking;
- unified billing presentation;
- absence of provider/model branding.

## Validation result

The Pass 6 code head `4f12943619f8f5e5855023929ad7013691ef80ef` passed:

- TypeScript build;
- rollout-flag and provider suites;
- Standard/Lite V1 regressions;
- unified V2 concurrency, rollback, and late-settlement suites;
- quota UI contract tests;
- execution profile, capability, tool, context, and request-budget suites;
- frontend syntax and bootstrap;
- frontend file generation, tool lifecycle, billing, and focused UI-state tests;
- Chromium runtime smoke.

The subsequent documentation-only commit does not change runtime behaviour.

## Deferred work

This pass does not:

- enable any rollout flag;
- apply production database migrations;
- deploy or merge the draft PR;
- change paid-plan token policy;
- change provider routing;
- redesign unrelated settings, billing, composer, or message surfaces.

Production activation remains a separate canary and deployment-readiness pass.
