# SentIQ Chat Android — Phase 3 core chat and continuity

## Status

Phase 3 turns the Phase 2 shell into a production-shaped native text-chat client. The Flutter app now owns optimistic turns, a cancellable SSE lifecycle, persisted request identity, message reconciliation, rich rendering, recovery states, and a virtualized long-thread surface while continuing to use the existing SentIQ Chat backend contract.

## Composer

The native composer grows from one to eight lines and exposes send/stop controls, Fast and Intuitive modes, quota-aware mode availability, a compact tool sheet, web-search state, file/image picking, attachment preparation, retry/remove actions, and per-message mode indicators. Images are carried as validated base64 attachments; other supported files are uploaded first and converted to backend file references.

## Turn identity and continuity

Every turn receives one UUID client request ID before network work starts. The same identifier is persisted in `chat_turns`, attached to the optimistic user and assistant records, and sent as `client_request_id`. Reconciliation keys on role plus request ID before falling back to message ID, preventing duplicate optimistic/cloud pairs.

SQLite schema version 4 adds:

- `messages`, indexed by owner, conversation and creation time;
- `chat_turns`, containing request ID, paired local message IDs, execution mode and recovery state;
- migrations from every prior Phase 2 schema without deleting conversation data.

Cloud messages are merged cache-first. Local pending, streaming, interrupted and cancelled states remain authoritative until a later cloud completion is available. Pending sync is replayed on network recovery and application foregrounding.

## Streaming lifecycle

`SentIQApiClient.postSseCancellable` uses a dedicated HTTP client per generation. Closing that client stops the socket without affecting ordinary API traffic. JSON tool responses are adapted into the same `structured_response` event path.

The controller handles every mobile-contract event:

- token and file-token output through a 32 ms render batcher;
- route, thinking and tool progress;
- source and citation updates;
- file analysis and artifacts;
- memory and sync notices;
- deep-research progress and failures;
- structured responses, errors, unknown events, newer event versions and terminal completion.

Cancellation works before or after the first token. A connection ending after content produces an interrupted response with Continue; an empty failed response exposes Retry. Generation state is kept per conversation, so changing conversations does not cancel another thread.

## Rich text and long threads

Assistant output uses native Flutter rendering for Markdown headings, lists, blockquotes, links, tables, inline code, fenced code with copy, LaTeX math and source chips. User and assistant messages support copy, selection, Ask about selection, Retry and Continue where applicable.

The thread uses `ListView.builder`, stable message keys, repaint boundaries, disabled automatic keep-alives and bounded cache extent. Streaming only follows the bottom while the reader remains near the latest message.

## Mobile contract version 2

The additive contract update declares `done`, chat sync, selection, title and conversation-message endpoints. Minimum compatible client contract remains version 1; unknown fields and unknown events remain ignorable.

## Evaluation coverage

Automated coverage includes:

- recorded replay of all declared SSE event types;
- cancellation before and after first content;
- interrupted streams and partial-response preservation;
- request-ID duplicate prevention;
- generation surviving conversation switching;
- independent Fast/Intuitive quota gates;
- lifecycle persistence and foreground reconciliation;
- SQLite v1-to-v4 migration;
- one-thousand-message virtualization;
- composer growth and send/stop state;
- Markdown, code, table, link, blockquote and math fixtures;
- backend mobile-contract compilation and endpoint assertions.
