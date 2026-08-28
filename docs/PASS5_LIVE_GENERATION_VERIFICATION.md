# Pass 5 live generation verification

These scripts are guarded live-environment checks. They must not run as part of normal startup or CI that has access to a production endpoint unless explicitly enabled.

## SSE disconnect/reconnect scenario

Set:

```bash
export SENTIQ_LIVE_GENERATION_VERIFY=true
export SENTIQ_LIVE_BASE_URL=https://<isolated-or-local-backend>
```

Run:

```bash
node scripts/verifyLiveGenerationReconnect.mjs
```

The scenario creates a dedicated guest generation, opens the durable generation SSE endpoint, waits for a real generation event, closes the subscriber without issuing cancellation, then reconnects with the last observed sequence as both the `after` cursor and `Last-Event-ID`.

The verifier requires:

- the generation does not become cancelled or failed merely because the subscriber disconnected;
- reconnect returns only sequences strictly after the disconnect cursor;
- replay contains no duplicate sequence numbers or sequence gaps;
- the generation eventually reaches `completed`;
- at least one event is delivered after reconnect.

The script emits only redacted owner information and lifecycle metadata. It does not print credentials or the generated response body.
