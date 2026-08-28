# Pass 5 slice — SSE disconnect/reconnect continuity

This slice adds `scripts/verifyLiveGenerationReconnect.mjs` as a guarded live-environment verifier.

Run:

```bash
SENTIQ_LIVE_GENERATION_VERIFY=true node scripts/verifyLiveGenerationReconnect.mjs
```

Optional environment variables:

- `SENTIQ_LIVE_BASE_URL`
- `SENTIQ_LIVE_OWNER_ID`
- `SENTIQ_LIVE_TIMEOUT_MS` (default 120000)
- `SENTIQ_LIVE_POLL_MS` (default 1000)
- `SENTIQ_LIVE_RECONNECT_DELAY_MS` (default 1500)

The scenario:

1. Creates a dedicated guest generation through the normal HTTP API.
2. Waits until the generation is running.
3. Opens the durable SSE generation-events endpoint.
4. Records the first real generation event as the disconnect cursor.
5. Aborts the SSE subscriber without calling the cancellation endpoint.
6. Verifies the durable generation is not immediately failed/cancelled.
7. Reconnects with both `after=<cursor>` and `Last-Event-ID`.
8. Requires strictly increasing post-cursor events and a terminal completed state.

The verifier intentionally does not print the generated response body or credentials.
