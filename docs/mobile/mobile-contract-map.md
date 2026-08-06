# SentIQ mobile contract map

Contract version: **1**

## Request identity

Every mobile request carries:

- `X-SentIQ-Anonymous-Id`: stable non-secret quota identity;
- `X-SentIQ-Mobile-Contract: 1`;
- `Authorization: Bearer <token>` when signed in;
- `Content-Type: application/json` for JSON requests.

## Foundation endpoint coverage

| Surface | Endpoint | Transport | Phase 1 fixture |
| --- | --- | --- | --- |
| Capabilities | `/api/config` | JSON | `config.json` |
| Text chat | `/api/chat` | JSON | shape represented in client tests |
| Streaming chat | `/api/chat/stream` | SSE or structured JSON | `chat_stream.sse` |
| Conversations | `/api/conversations` | JSON | endpoint registry |
| File upload | `/api/files/upload` | multipart | contract declaration |
| File analysis updates | `/api/files/updates` | SSE | `file_updates.sse` |
| Image generation | `/api/images/generate` | JSON | `image_generate.json` |
| Deep Research | `/api/deep-research/start` | JSON/SSE lifecycle | `deep_research.sse` |
| Billing summary | `/api/billing/me` | JSON | `billing_me.json` |
| Live status | `/api/live/status` | JSON | contract declaration |
| Live token | `/api/live/session-token` | JSON | `live_session.json` |

## SSE compatibility

The parser recognizes current chat, tool, WebSurf, file, memory, synchronization, Deep Research, error, and completion events. Unknown event types are emitted as `unknown`; they are never discarded at the transport boundary. Envelope versions above the supported version are flagged without losing their raw payload.

## Change policy

Backend changes compatible with contract version 1 may add fields or event types. Removing fields, changing field meaning, changing an endpoint's transport, or requiring a different request shape requires a new contract version and an overlap period where the previous client contract remains supported.
