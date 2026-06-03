# SentIQGPT Architecture

## System Overview

SentIQGPT is an authenticated AI assistant with persistent conversations, memory, file handling, generated files, image generation, chart generation, and web search. The browser keeps local IndexedDB state for responsiveness, while the backend owns canonical authenticated data in sharded Supabase databases.

| Area | Current Behavior |
| --- | --- |
| Frontend | Browser UI with IndexedDB-backed chats, memories, uploaded file state, and sync helpers |
| Backend | Express + TypeScript API, auth, validation, orchestration, persistence, SSE, and generated artifacts |
| LLM gateway | Python service for provider routing, streaming, safety checks, and embeddings |
| Databases | Supabase control DB plus data shards for user conversations, memories, usage, images, and files |
| Routing | Backend-owned orchestrator selects conversation, memory, file, chart, image, math, and search tools |
| Storage | Supabase storage for generated images/files; DB rows remain the canonical metadata |

## Request Flow

1. The browser sends authenticated requests to the Express API.
2. The backend resolves identity, applies rate limits, validates payloads, and routes to the appropriate handler.
3. Node calls the loopback-only Python model gateway with `X-SentIQ-Internal-Token`; the browser never calls that gateway directly.
4. Chat requests build context from recent messages, memory retrieval, uploaded file context, and optional conversation summaries.
5. The orchestrator executes tool steps sequentially for side-effecting work and passes abort signals into cancellable operations.
6. Canonical responses, messages, memories, images, generated files, and quota usage are persisted on the user shard when applicable.
7. The frontend reconciles server responses with local IndexedDB state.

## Auth, Rate Limits, And Reliability

- Auth is resolved before AI/upload limiters, and the global general limiter attempts a lightweight identity pre-resolution so signed-in users are keyed by `user:<id>` instead of only IP.
- Guest chat is allowed only on explicitly guest-enabled routes.
- Fatal backend errors use a shared shutdown path that stops accepting new HTTP connections, waits for active requests to drain, and exits so the process manager can restart cleanly.
- Startup shard verification checks required tables, columns, and RPCs before serving traffic.
- Production startup rejects a missing internal gateway token, unsafe tokenless overrides, and non-loopback Python bindings.

## Data And Sharding

- The control DB stores user-to-shard assignment.
- Data shards store conversations, messages, memories, usage logs, generated files, and chat images.
- Conversation creation and chat turns use canonical IDs and idempotency helpers to avoid duplicate blank chats.
- Conversation listing uses the `list_user_conversations(p_user_id)` RPC, which returns counts and preview fields without fetching every message row into the backend.

## Streaming And SSE

- `/api/chat/stream` streams chat tokens with request cancellation and avoids persisting partial assistant output after client disconnect.
- `/api/files/updates` streams file-analysis status events scoped to the authenticated upload owner.
- SSE status events avoid broadcasting extracted document text.

## Memory And Context

- Backend memory retrieval is owner-scoped and contributes relevant facts to prompt context.
- Context building combines recent chat messages, memory retrieval, optional summaries, file context, and image attachments.
- File chunking utilities clamp invalid chunk/overlap settings and guarantee forward progress. Current prompt assembly may still pass selected file text directly where route behavior requires it.

## Generated Artifacts

- Generated files are stored privately in Supabase storage with DB metadata and authorized download/preview routes.
- Generated HTML previews are rendered without script execution by default.
- Generated images use DB-backed quota reservations and Supabase-backed persistence.
- The image router is still in-process, but it uses per-user queues, bounded concurrency, per-user queue limits, provider cooldowns, and sequential provider fallback per request.

## Main Backend Areas

| Path | Responsibility |
| --- | --- |
| `backend/server.ts` | Express routes, auth boundaries, streaming, persistence orchestration |
| `backend/orchestrator/*` | Planning, clarification, tool execution, answer finalization |
| `backend/context/*` | Context assembly, compression, file chunking, reference resolution |
| `backend/services/*` | Database-backed conversation, memory, profile, quota, and persistence services |
| `backend/tools/*` | Image, chart, file generation, and web search tools |
| `backend/llm_service.py` | Loopback Python gateway for LLM invoke/stream/embed and safety enforcement; all non-liveness routes require internal authentication |

## Operational Notes

- Apply shard migrations to every data shard before deploying code that depends on new RPCs.
- Keep generated artifact metadata and storage objects reconciled during maintenance.
- Treat the in-process image queue as single-instance stabilization, not a durable production job queue.
