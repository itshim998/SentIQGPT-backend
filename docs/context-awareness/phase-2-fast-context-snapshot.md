# Phase 2 — Fast Context Snapshot

## Objective

Fast mode must recover high-value durable context after process cold starts without adding another AI call or a chain of database queries.

The implementation uses one bounded Supabase RPC, `get_fast_context_snapshot`, and a strict application-side timeout. The process-local capsule cache remains an immediate fallback and speed optimization, but it is no longer Fast mode's only durable capsule source.

## Snapshot contract

The data-shard RPC returns one JSON object containing:

- the latest 20 canonical messages for the active conversation, in chronological order;
- a canonical message cursor (`id` and `created_at`);
- the current conversation capsule, including its source cursor and version;
- the current workspace capsule, including its source cursor and version;
- up to eight lexically relevant global/chat memories;
- up to twelve source-document identities associated with the conversation or explicitly attached document IDs;
- a compact cursor/version object for telemetry and future incremental reads.

The RPC is `stable`, `security invoker`, owner/conversation scoped, and read-only. It performs no inserts, updates, deletes, function calls, embedding generation, or capsule refresh.

## Fast request behavior

The snapshot starts at the beginning of `buildContextFast` and runs concurrently with source retrieval and any enabled prior-conversation evidence read. Ordinary Fast streaming already invokes context building concurrently with model capability routing.

Default timeout: **225 ms**.

The timeout can be changed with `SENTIQ_FAST_CONTEXT_SNAPSHOT_TIMEOUT_MS`, clamped to 25–2,000 ms.

Outcomes:

| Snapshot result | Fast behavior |
|---|---|
| Available | Merge canonical messages with the browser hint; use snapshot memories and capsules. |
| Timeout | Continue with local recent messages and cached capsules. |
| Database/RPC degradation | Continue with local recent messages and cached capsules. |
| Guest or missing conversation | Skip the RPC entirely. |

The timed-out RPC is not awaited by the request path. No failure in the snapshot can indefinitely hold model generation.

## Server-authoritative history merge

Browser history is treated as a low-latency hint:

1. Canonical server messages are the base sequence.
2. The latest fingerprint overlap between canonical and browser sequences acts as the merge cursor.
3. Only browser messages after that overlap can be appended as an optimistic tail.
4. When there is no overlap, canonical history wins; unverifiable browser history is not appended.
5. Adjacent duplicates are collapsed.
6. A trailing user message equal to the current request is removed because the current request is injected separately and last.
7. The final candidate window remains bounded by `CONVERSATION_WINDOW` (20 messages).

This fills browser gaps while avoiding duplicate or stale history.

## Memory and capsule safety

Fast mode no longer calls the cloud-memory fetch path. That path may enqueue or process embedding maintenance and is reserved for the full context builder.

Fast mode also never calls capsule refresh. It uses:

1. snapshot capsule when available;
2. process-local cached capsule otherwise;
3. no capsule if neither source is available.

## Source-document identities

The snapshot exposes document IDs, titles, original filenames, MIME/source types, status, metadata, and timestamps. Current explicit document IDs are prioritized, followed by recent conversation-scoped documents.

Phase 2 keeps these identities as durable context metadata. Source chunk retrieval continues to occur only through the existing bounded source-retrieval path when file references are present, avoiding an automatic file-query penalty on ordinary Fast turns.

## Telemetry

`BuiltContext.fastContextSnapshot` reports:

- status;
- elapsed and timeout milliseconds;
- message cursor;
- conversation/workspace capsule versions.

Structured logs report snapshot availability, selected message/memory/source counts, and capsule versions without logging prompt contents.

## Deployment

Apply `supabase/migrations/20260804180700_add_fast_context_snapshot.sql` to data shards 2, 3, and 4 before relying on snapshot availability. Until all shards are migrated, Fast requests degrade safely to local history and cached capsules.

## Non-goals and preserved constraints

- No provider, model, provider order, endpoint, key, quota, output-token, reasoning-budget, or Azure scaling change.
- No additional model call.
- No embedding generation or capsule refresh in Fast request handling.
- No blocking dependency on the snapshot.
- No automatic retrieval of every historical file on ordinary messages.
