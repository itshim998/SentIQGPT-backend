# Fast Mode Wave 0 — Real Latency Attribution

Status: implemented for Fast execution mode only.

## Objective

Measure the real path from a user's send action to the first visible answer token without changing models, prompts, routing, safety decisions, billing behavior, persistence behavior, or generated answers.

The trace key is the existing `client_request_id`. The browser appends it to the Fast stream URL as `latency_trace_id`; the Node preload propagates the same value to the internal Python gateway through `X-SentIQ-Latency-Trace`.

## Instrumented path

```text
Browser send intent
  -> stream API invocation
  -> browser fetch dispatch
  -> public response headers
  -> first answer token received
  -> first answer token painted

Node request ingress
  -> billing/plan/quota RPCs
  -> Supabase auth fallback, when used
  -> internal Python gateway request
  -> first Python stream chunk received
  -> public response headers sent
  -> first SSE answer token written
  -> request finish or disconnect

Python request ingress
  -> input-safety provider request and completion
  -> Groq/Gemini/Pollinations/NVIDIA request
  -> provider response headers
  -> first provider SSE event
  -> first visible provider delta
  -> Python request completion
```

## Structured log contract

Every server event is one JSON object with:

- `schema_version`: currently `1`
- `scope`: `fast_latency`
- `layer`: `client`, `node`, or `python`
- `phase`: stable phase name
- `trace_id`: validated client request identifier
- `execution_mode`: always `fast`
- `epoch_ms`: wall-clock timestamp for log ordering
- `elapsed_ms`: monotonic time since that layer received the request, where available

No prompt, answer, memory, file content, image data, authorization header, API key, email address, display name, or raw request body is logged.

## Browser reports

The browser emits two compact reports:

1. `first_paint`: first answer token received and, when the page is visible, painted through two animation frames.
2. `terminal`: stream completion, interruption, abort, network failure, or exception.

Metrics:

- `send_intent_to_stream_call_ms`
- `send_intent_to_fetch_ms`
- `fetch_to_headers_ms`
- `headers_to_first_token_ms`
- `send_to_first_token_ms`
- `first_token_to_paint_ms`
- `send_to_first_paint_ms`
- `stream_total_ms`

Network hints are bounded to browser-provided `effective_type`, `rtt_ms`, `save_data`, and page visibility. They contain no IP or location. The report endpoint accepts only text/plain JSON, limits bodies to 12 KiB, validates every field, and applies an in-memory per-IP rate limit before logging.

## Node phases

- `server.request_received`
- `server.response_headers_sent`
- `server.first_sse_token_written`
- `server.request_completed`
- `server.billing_rpc_started|completed|failed`
- `server.auth_fallback_started|completed|failed`
- `server.internal_gateway_started|completed|failed`
- `server.internal_gateway_first_chunk_received`

Billing operations are classified by Supabase RPC path. The instrumentation does not inspect prompt or response content. The only SSE inspection is a bounded 32 KiB rolling probe for the event type names `token` and `file_token`.

## Python phases

- `python.request_received`
- `python.safety_request_started`
- `python.safety_response_headers_received`
- `python.safety_request_completed`
- `python.provider_request_started`
- `python.provider_response_headers_received`
- `python.provider_first_sse_event`
- `python.provider_first_visible_delta`
- `python.request_completed`

Provider classification uses only destination hostname and the provider model identifier. SSE parsing checks only whether the first choice contains non-empty visible content or a tool call; it never logs the delta itself.

## Runtime activation

`scripts/start-container.sh` enables the preloads before starting Node and Python:

- Node: `--require=backend/observability/fast-latency-preload.cjs`
- Python: `backend/run_llm_service.py`, which installs the hooks and then executes the unchanged `backend/llm_service.py` entrypoint

Configuration:

```bash
SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED=true
SENTIQ_FAST_LATENCY_SAMPLE_RATE=1
```

The sample decision is deterministic from `trace_id`. Node propagates a trace to Python only when the trace is sampled. Set the rate to `0.1` after the baseline window if full-volume logging is no longer required.

Observability fails open: installation, telemetry delivery, parsing, or logging errors must not block chat startup or generation.

## Validation commands

```bash
node scripts/test-fast-latency-observability.mjs
node scripts/test-fast-latency-browser.mjs
python backend/test_fast_latency_observability.py
bash -n scripts/start-container.sh
node --check frontend/scripts/observability/fast-latency.js
node --check backend/observability/fast-latency-preload.cjs
python -m py_compile backend/fast_latency_observability.py backend/run_llm_service.py
```

## Baseline audit procedure

Collect at least 500 successful ordinary Fast text requests and segment by:

- guest vs signed in
- new vs existing conversation
- local JWT vs Supabase fallback
- Groq vs fallback provider
- prompt token bucket
- cached-token ratio
- warm vs newly started replica
- one vs multiple concurrent streams
- successful vs interrupted requests
- visible vs hidden browser tab

Calculate p50, p75, p95, and p99 for:

1. send intent -> fetch dispatch
2. fetch dispatch -> browser response headers
3. Node ingress -> billing completion
4. Node ingress -> Python gateway start
5. Python ingress -> safety completion
6. Python ingress -> provider request start
7. provider request -> first visible provider delta
8. Node ingress -> first SSE token write
9. browser headers -> first token received
10. first token received -> first paint
11. send intent -> first paint

## Attribution interpretation

- High `send_intent_to_fetch_ms`: frontend persistence/context/auth work before dispatch.
- High Node billing RPC duration: plan and quota database serialization.
- High Python safety duration before provider start: blocking input-safety gate.
- High provider-start to first-visible-delta: provider queue, prompt prefill, reasoning, or network.
- High Node internal-gateway-first-chunk to first-SSE-token-written: server parsing/proxy delay.
- High browser headers-to-first-token: upstream generation or buffering after headers.
- High first-token-to-paint: rendering/main-thread contention.
- High p95/p99 only after replica startup: Azure cold-start or readiness path.
- High auth-fallback duration: local JWT verification is not serving the request.

## Known boundaries

- Browser and server clocks are not assumed to be synchronized. Cross-layer analysis uses the common trace ID and monotonic durations within each layer.
- A send initiated outside the standard send button or Enter key path is marked `intent_inferred=true`; its pre-dispatch value begins at stream API invocation.
- First paint is reported only while the document is visible. Hidden tabs report first token without claiming a paint measurement.
- The Node preload sees fetch-based Supabase and internal-gateway operations. Non-fetch database clients would require explicit instrumentation.
- The provider-first-visible-delta detector covers OpenAI-compatible SSE streams. Buffered provider fallbacks still produce request/headers timings but no provider delta phase.

## Wave 0 completion gate

Wave 0 is complete when production logs prove that a single trace can be reconstructed from browser send intent through Node, Python, provider first visible delta, Node first SSE token write, browser first token receipt, and browser first paint, with no user content in telemetry and no measurable answer-path regression.
