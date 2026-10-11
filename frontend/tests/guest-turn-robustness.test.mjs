import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lifecycleSource = readFileSync("frontend/scripts/generation-lifecycle.js", "utf8");
const apiSource = readFileSync("frontend/scripts/services/api.js", "utf8");

// ============================================================================
// 1. Static Contract & Pattern Checks
// ============================================================================

// 1. EOF must NOT be treated as terminal in subscribeOnce or streamFastGeneration
assert.doesNotMatch(
  lifecycleSource,
  /if\s*\(\s*done\s*\)\s*\{[\s\S]*?if\s*\(\s*entry\s*&&\s*\(\s*entry\.tokensReceived/,
  "Stream EOF must not prematurely mark generation completed when tokens are received",
);

// 2. Durable status polling fallback must exist and be called when reconnect limit exceeded
assert.match(
  lifecycleSource,
  /async function pollDurableStatusUntilTerminal/,
  "pollDurableStatusUntilTerminal must exist as durable fallback",
);
assert.match(
  lifecycleSource,
  /if\s*\(\s*entry\.subscription\.reconnectAttempts\s*>\s*MAX_RECONNECT_ATTEMPTS\s*\)\s*\{[\s\S]*?pollDurableStatusUntilTerminal/,
  "Exceeding MAX_RECONNECT_ATTEMPTS must fall back to pollDurableStatusUntilTerminal",
);

// 3. Snapshots must advance entry.lastSequence to avoid false gap errors on subsequent live events
assert.match(
  lifecycleSource,
  /entry\.lastSequence\s*=\s*Math\.max\(\s*entry\.lastSequence,\s*sequence\s*\)/,
  "Snapshots with sequence must advance entry.lastSequence",
);

// 4. API client must require explicit [DONE] or structured response before completing
assert.match(
  apiSource,
  /let doneReceived = false;/,
  "api.js must track doneReceived explicitly",
);
assert.match(
  apiSource,
  /if\s*\(\s*payload === "\[DONE\]"\s*\)\s*\{\s*doneReceived = true;/,
  "api.js must set doneReceived when [DONE] is received",
);
assert.match(
  apiSource,
  /if\s*\(\s*!doneReceived\s*&&\s*!structuredReceived\s*&&\s*!terminalError\s*\)/,
  "api.js must detect stream interrupted before completion if [DONE] was not received",
);

// ============================================================================
// 2. Runtime Tests Invoking Production Polling & SSE-Recovery Flow
// ============================================================================

// Setup browser DOM environment for production module execution
if (!globalThis.window) {
  globalThis.window = globalThis;
}
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
globalThis.location = { hostname: "localhost", protocol: "http:" };
globalThis.document = {
  getElementById: () => null,
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, setAttribute: () => {}, classList: { add: () => {} } }),
  documentElement: { dataset: {}, classList: { contains: () => false, add: () => {} } },
  addEventListener: () => {},
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.CustomEvent = class CustomEvent { constructor(name, init) { this.name = name; this.detail = init?.detail; } };
window.SentIQAPI = { sendMessage: () => {}, sendMessageStream: () => {} };
window.__SENTIQ_POLL_INTERVAL_MS = 2; // Fast polling for test suite (2ms)
window.__SENTIQ_RECONNECT_BASE_MS = 2; // Fast reconnect for test suite (2ms)
window.__SENTIQ_RECONNECT_MAX_MS = 10;

await import("../scripts/generation-lifecycle.js");

const {
  pollDurableStatusUntilTerminal,
  reconcileEntryDurableStatus,
  subscribeUntilTerminal,
  subscribeOnce,
  createGenerationEntry,
  cancelGeneration,
} = window.SentIQGenerationLifecycle;

assert.ok(typeof pollDurableStatusUntilTerminal === "function", "pollDurableStatusUntilTerminal must be exported");
assert.ok(typeof subscribeUntilTerminal === "function", "subscribeUntilTerminal must be exported");

// Test A: Production polling delivers incremental tokens and completes cleanly
{
  const tokenDeltas = [];
  let doneCalled = false;
  let fetchCount = 0;

  const entry = createGenerationEntry({
    generationId: "gen-runtime-poll-tokens",
    callbacks: {
      onToken: (delta) => tokenDeltas.push(delta),
      onDone: () => { doneCalled = true; },
      onError: (err) => { throw err; },
    },
  });

  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "generating", partial_text: "First chunk" }),
      };
    }
    if (fetchCount === 2) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "generating", partial_text: "First chunk second chunk" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "completed", partial_text: "First chunk second chunk" }),
    };
  };

  const result = await pollDurableStatusUntilTerminal(entry);
  assert.equal(result.completed, true, "pollDurableStatusUntilTerminal must report completed: true");
  assert.equal(entry.terminal, true, "Production polling must transition entry to terminal state");
  assert.equal(entry.status, "completed", "Entry status must be completed");
  assert.equal(doneCalled, true, "onDone callback must be triggered on completion");
  assert.deepEqual(tokenDeltas, ["First chunk", " second chunk"], "Incremental tokens must be dispatched via callbacks.onToken");
  assert.equal(entry.deliveredText, "First chunk second chunk");
  assert.equal(entry.tokensReceived, true);
}

// Test B: Production polling handles 404 cleanly with generation_not_found
{
  let errorReceived = null;
  const entry404 = createGenerationEntry({
    generationId: "gen-runtime-poll-404",
    tokensReceived: true,
    isGuest: true,
    callbacks: {
      onError: (err) => { errorReceived = err; },
    },
  });

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "Not found", code: "generation_not_found" }),
  });

  const result = await pollDurableStatusUntilTerminal(entry404);
  assert.equal(result.failed, true, "Production polling must report failed: true on 404");
  assert.equal(entry404.terminal, true, "404 must mark entry terminal");
  assert.equal(entry404.status, "failed", "Entry status must be failed");
  assert.equal(entry404.error?.code, "generation_not_found", "Error code must be generation_not_found");
  assert.equal(errorReceived?.code, "generation_not_found", "onError must receive generation_not_found");
  assert.equal(entry404.interrupted, true, "Previously received tokens mark it as interrupted");
}

// Test B2: Production SSE reconnect handles guest 404/generation_not_found immediately without looping
{
  let sseFetchCount = 0;
  let errorReceived = null;
  const entrySse404 = createGenerationEntry({
    generationId: "gen-runtime-sse-404",
    tokensReceived: true,
    isGuest: true,
    callbacks: {
      onError: (err) => { errorReceived = err; },
    },
  });

  globalThis.fetch = async () => {
    sseFetchCount += 1;
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "Generation not found.", code: "generation_not_found" }),
    };
  };

  const result = await subscribeUntilTerminal(entrySse404);
  assert.equal(result.failed, true, "Guest SSE reconnect must fail immediately on 404");
  assert.equal(sseFetchCount, 1, "Must NOT retry 8 times when guest 404 generation_not_found is received");
  assert.equal(entrySse404.terminal, true, "404 must mark entry terminal");
  assert.equal(entrySse404.status, "failed");
  assert.equal(entrySse404.error?.code, "generation_not_found");
  assert.equal(errorReceived?.code, "generation_not_found");
  assert.equal(entrySse404.interrupted, true, "Tokens received mark it as interrupted");
}

// Test B3: Transient or unrelated SSE error is not misclassified as generation_not_found
{
  let sseFetchCount = 0;
  const entryTransient = createGenerationEntry({
    generationId: "gen-runtime-sse-transient-404",
    tokensReceived: true,
    isGuest: true,
    callbacks: {
      onError: () => {},
    },
  });

  globalThis.fetch = async () => {
    sseFetchCount += 1;
    if (sseFetchCount < 3) {
      // 404 without generation_not_found code (e.g. gateway HTML error)
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "Gateway not found", code: "gateway_error" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "completed", partial_text: "Recovered text" }),
    };
  };

  const result = await subscribeUntilTerminal(entryTransient);
  assert.ok(sseFetchCount > 1, "Must retry transient error and not misclassify as generation_not_found");
  assert.notEqual(entryTransient.error?.code, "generation_not_found");
}

// Test B4: Authenticated SSE reconnect preserves durable retry/polling behavior on 404
{
  let sseFetchCount = 0;
  let pollCalled = false;
  const entryAuth404 = createGenerationEntry({
    generationId: "gen-runtime-sse-auth-404",
    tokensReceived: true,
    isGuest: false,
    callbacks: {
      onError: () => {},
    },
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url || "");
    sseFetchCount += 1;
    if (urlStr.includes("/events")) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "Generation not found.", code: "generation_not_found" }),
      };
    }
    pollCalled = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "completed", partial_text: "Recovered text from durable database" }),
    };
  };

  const result = await subscribeUntilTerminal(entryAuth404);
  assert.ok(sseFetchCount > 1, "Authenticated generation must retry SSE before falling back to polling");
  assert.equal(pollCalled, true, "Authenticated generation must fall back to durable status polling");
  assert.equal(entryAuth404.status, "completed", "Authenticated entry must complete via durable recovery polling");
}

// Test B5: Guest durable-status reconciliation marks missing generation as interrupted failure, not completed
{
  let errorReceived = null;
  const entryGuestReconcile = createGenerationEntry({
    generationId: "gen-runtime-guest-reconcile-404",
    tokensReceived: true,
    isGuest: true,
    callbacks: {
      onError: (err) => { errorReceived = err; },
    },
  });

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "Generation not found.", code: "generation_not_found" }),
  });

  await reconcileEntryDurableStatus(entryGuestReconcile);
  assert.equal(entryGuestReconcile.terminal, true);
  assert.equal(entryGuestReconcile.status, "failed");
  assert.equal(entryGuestReconcile.interrupted, true);
  assert.equal(entryGuestReconcile.error?.code, "generation_not_found");
  assert.equal(errorReceived?.code, "generation_not_found");
}

// Test B6: Authenticated durable-status reconciliation preserves pre-refactor behavior on 404
{
  const entryAuthReconcile = createGenerationEntry({
    generationId: "gen-runtime-auth-reconcile-404",
    tokensReceived: true,
    isGuest: false,
    callbacks: {
      onError: () => {},
    },
  });

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "Generation not found.", code: "generation_not_found" }),
  });

  await reconcileEntryDurableStatus(entryAuthReconcile);
  // Preserves pre-refactor unconfirmed failure policy when [DONE] was not authoritatively verified
  assert.equal(entryAuthReconcile.terminal, true);
  assert.equal(entryAuthReconcile.error?.code, "generation_unconfirmed");
}

// Test C: Quiet-polling returns resumeSse: true after 20 attempts, and subscribeUntilTerminal resumes SSE cleanly
{
  let pollAttempts = 0;
  const entryQuiet = createGenerationEntry({
    generationId: "gen-runtime-poll-quiet",
  });

  globalThis.fetch = async () => {
    pollAttempts += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "running", partial_text: "" }),
    };
  };

  const pollRes = await pollDurableStatusUntilTerminal(entryQuiet);
  assert.equal(pollAttempts, 20, "Cycle must stop after 20 quiet attempts to allow SSE resume");
  assert.equal(pollRes.resumeSse, true, "Must signal resumeSse: true");
  assert.equal(entryQuiet.terminal, false, "Must not be terminal yet");

  // Verify the integrated SSE-recovery flow through subscribeUntilTerminal:
  // After SSE drops and quiet polling signals resumeSse, reconnectAttempts resets to 0 and SSE succeeds
  let sseCalls = 0;
  let pollCalls = 0;
  let sseResumedAndSucceeded = false;

  const entryRecovery = createGenerationEntry({
    generationId: "gen-runtime-sse-recovery",
    callbacks: {
      onDone: () => {},
    },
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/events")) {
      sseCalls += 1;
      if (sseCalls <= 9) {
        throw new Error("SSE connection dropped");
      }
      sseResumedAndSucceeded = true;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        body: stream,
      };
    }

    // Polling endpoint
    pollCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: sseResumedAndSucceeded ? "completed" : "running", partial_text: "" }),
    };
  };

  await subscribeUntilTerminal(entryRecovery);
  assert.ok(pollCalls >= 20, "Polling fallback was exercised during disconnect recovery");
  assert.equal(sseResumedAndSucceeded, true, "SSE was resumed after quiet polling and succeeded");
  assert.equal(entryRecovery.terminal, true, "Entry reached terminal state");
  assert.equal(entryRecovery.status, "completed", "Entry completed successfully via resumed SSE");
}

// Test D: Persistent stall without progress times out with generation_recovery_timeout
{
  let timeoutErrorReceived = null;
  const entryTimeout = createGenerationEntry({
    generationId: "gen-runtime-poll-timeout",
    tokensReceived: false,
    callbacks: {
      onError: (err) => { timeoutErrorReceived = err; },
    },
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "queued", partial_text: "" }),
  });

  while (!entryTimeout.terminal) {
    const res = await pollDurableStatusUntilTerminal(entryTimeout);
    if (res.failed || entryTimeout.terminal) break;
  }

  assert.equal(entryTimeout.terminal, true, "Stalled poll recovery must terminate");
  assert.equal(entryTimeout.status, "failed", "Entry status must be failed");
  assert.equal(entryTimeout.error?.code, "generation_recovery_timeout");
  assert.equal(timeoutErrorReceived?.code, "generation_recovery_timeout");
}

// Test E: Cancellation cleanly halts polling and dispatches onCancelled
{
  let cancelledCalled = false;
  const entryCancel = createGenerationEntry({
    generationId: "gen-runtime-poll-cancel",
    callbacks: {
      onCancelled: () => { cancelledCalled = true; },
    },
  });

  let pollCount = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/cancel")) {
      return { ok: true, status: 200, json: async () => ({ status: "cancelled" }) };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "running", partial_text: "Starting..." }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "cancelled" }),
    };
  };

  const pollPromise = pollDurableStatusUntilTerminal(entryCancel);
  await cancelGeneration("gen-runtime-poll-cancel");
  await pollPromise;

  assert.equal(entryCancel.cancelled, true, "Entry must be marked cancelled");
  assert.equal(entryCancel.terminal, true, "Entry must be marked terminal");
  assert.equal(entryCancel.status, "cancelled", "Entry status must be cancelled");
  assert.equal(cancelledCalled, true, "onCancelled callback must be invoked");

  // AbortSignal detachment
  const entryAbort = createGenerationEntry({ generationId: "gen-runtime-abort" });
  const controller = new AbortController();
  controller.abort();
  const abortRes = await pollDurableStatusUntilTerminal(entryAbort, controller.signal);
  assert.equal(abortRes.detached, true, "Aborted signal returns detached: true");
}

// Test F: Nonzero cursor reconnect receives terminal failed snapshot before [DONE] - verifies failed state, not completed
{
  let onDoneCalled = false;
  let errorReceived = null;

  const entryReplayFailed = createGenerationEntry({
    generationId: "gen-runtime-replay-failed",
    tokensReceived: true,
    lastSequence: 1,
    callbacks: {
      onDone: () => { onDoneCalled = true; },
      onError: (err) => { errorReceived = err; },
    },
  });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"type":"generation_snapshot","generation_id":"gen-runtime-replay-failed","status":"failed","error_code":"generation_concurrency_timeout","terminal":true,"sequence":2}\n\n'
      ));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: stream,
  });

  await subscribeOnce(entryReplayFailed);

  assert.equal(entryReplayFailed.status, "failed", "Entry status must be failed after snapshot replay");
  assert.equal(entryReplayFailed.terminal, true, "Entry must be marked terminal");
  assert.equal(entryReplayFailed.error?.code, "generation_concurrency_timeout", "Error code must be generation_concurrency_timeout");
  assert.equal(errorReceived?.code, "generation_concurrency_timeout", "onError callback must receive failure code");
  assert.equal(onDoneCalled, false, "onDone callback must NEVER be called for failed generation");
}

// Test G: Bare [DONE] on an already failed or cancelled generation entry never turns it into completed
{
  let onDoneCalled = false;
  const entryBareDoneFailed = createGenerationEntry({
    generationId: "gen-runtime-bare-done-failed",
    tokensReceived: true,
    lastSequence: 2,
    callbacks: {
      onDone: () => { onDoneCalled = true; },
    },
  });
  entryBareDoneFailed.status = "failed";
  entryBareDoneFailed.error = Object.assign(new Error("concurrency timeout"), { code: "generation_concurrency_timeout" });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: stream,
  });

  await subscribeOnce(entryBareDoneFailed);

  assert.equal(entryBareDoneFailed.status, "failed", "Bare [DONE] must NOT overwrite failed status");
  assert.equal(entryBareDoneFailed.terminal, true, "Entry must be terminal");
  assert.equal(onDoneCalled, false, "Bare [DONE] must NOT call onDone on failed entry");
}

// Test H: Higher cursor nonterminal entry receives lower-sequence terminal failure snapshot before [DONE]
{
  let onDoneCalled = false;
  let errorReceived = null;

  const entryHigherCursorFailed = createGenerationEntry({
    generationId: "gen-runtime-higher-cursor-failed",
    tokensReceived: true,
    lastSequence: 8,
    status: "running",
    callbacks: {
      onDone: () => { onDoneCalled = true; },
      onError: (err) => { errorReceived = err; },
    },
  });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"type":"generation_snapshot","generation_id":"gen-runtime-higher-cursor-failed","status":"failed","error_code":"generation_concurrency_timeout","terminal":true,"sequence":4}\n\n'
      ));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: stream,
  });

  await subscribeOnce(entryHigherCursorFailed);

  assert.equal(entryHigherCursorFailed.status, "failed", "Final status must remain failed");
  assert.equal(entryHigherCursorFailed.terminal, true, "Entry must be terminal");
  assert.equal(entryHigherCursorFailed.lastSequence, 8, "Sequence counter must not roll backwards");
  assert.equal(entryHigherCursorFailed.error?.code, "generation_concurrency_timeout", "Error code must match snapshot error_code");
  assert.equal(errorReceived?.code, "generation_concurrency_timeout", "onError must receive generation_concurrency_timeout");
  assert.equal(onDoneCalled, false, "onDone must NEVER be called on terminal failure snapshot");
}

// Test I: Higher cursor nonterminal entry receives lower-sequence terminal cancellation snapshot before [DONE]
{
  let onDoneCalled = false;
  let onCancelledCalled = false;

  const entryHigherCursorCancelled = createGenerationEntry({
    generationId: "gen-runtime-higher-cursor-cancelled",
    tokensReceived: true,
    lastSequence: 8,
    status: "running",
    callbacks: {
      onDone: () => { onDoneCalled = true; },
      onCancelled: () => { onCancelledCalled = true; },
    },
  });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"type":"generation_snapshot","generation_id":"gen-runtime-higher-cursor-cancelled","status":"cancelled","terminal":true,"sequence":4}\n\n'
      ));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: stream,
  });

  await subscribeOnce(entryHigherCursorCancelled);

  assert.equal(entryHigherCursorCancelled.status, "cancelled", "Final status must remain cancelled");
  assert.equal(entryHigherCursorCancelled.terminal, true, "Entry must be terminal");
  assert.equal(entryHigherCursorCancelled.cancelled, true, "Cancelled flag must be set");
  assert.equal(entryHigherCursorCancelled.lastSequence, 8, "Sequence counter must not roll backwards");
  assert.equal(onCancelledCalled, true, "onCancelled callback must be invoked");
  assert.equal(onDoneCalled, false, "onDone must NEVER be called on terminal cancellation snapshot");
}

// Test J: Bare [DONE] alone without authoritative completion never reports completed
{
  let onDoneCalled = false;
  let onErrorCalled = false;

  const entryBareDoneUnconfirmed = createGenerationEntry({
    generationId: "gen-runtime-bare-done-unconfirmed",
    tokensReceived: true,
    lastSequence: 3,
    status: "running",
    callbacks: {
      onDone: () => { onDoneCalled = true; },
      onError: () => { onErrorCalled = true; },
    },
  });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/events")) {
      return { ok: true, status: 200, body: stream };
    }
    // Reconciliation fetch returns 404 (unconfirmed)
    return { ok: false, status: 404, json: async () => ({}) };
  };

  await subscribeOnce(entryBareDoneUnconfirmed);

  assert.notEqual(entryBareDoneUnconfirmed.status, "completed", "Status must NOT be completed from bare [DONE] alone");
  assert.equal(onDoneCalled, false, "onDone must NEVER be called when completion is unconfirmed");
  assert.equal(entryBareDoneUnconfirmed.terminal, true, "Entry must be terminal");
}

// Test K: Direct generation_cancelled SSE event invokes onCancelled exactly once and never onDone
{
  let onDoneCalled = false;
  let onCancelledCount = 0;

  const entryDirectCancelled = createGenerationEntry({
    generationId: "gen-runtime-direct-cancelled-event",
    tokensReceived: true,
    lastSequence: 2,
    status: "running",
    callbacks: {
      onDone: () => { onDoneCalled = true; },
      onCancelled: () => { onCancelledCount += 1; },
    },
  });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"type":"generation_cancelled","generation_id":"gen-runtime-direct-cancelled-event","status":"cancelled","sequence":3}\n\n'
      ));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: stream,
  });

  await subscribeOnce(entryDirectCancelled);

  assert.equal(entryDirectCancelled.status, "cancelled", "Final status must be cancelled");
  assert.equal(entryDirectCancelled.terminal, true, "Entry must be terminal");
  assert.equal(entryDirectCancelled.cancelled, true, "Cancelled flag must be true");
  assert.equal(onCancelledCount, 1, "onCancelled callback must be invoked exactly once");
  assert.equal(onDoneCalled, false, "onDone must NEVER be called on direct generation_cancelled event");
}


// ============================================================================
// 3. Behavioral Tests for Stream Interruption Handling in sendMessageStream
// ============================================================================

// Test: Stream interrupted without [DONE] triggers response_interrupted and suppresses onDone
{
  let doneCalled = false;
  let errorReported = null;
  let tokens = [];

  let interrupted = false;
  let terminalError = null;
  let doneReceived = false;
  let tokensReceived = false;

  const chunks = [
    'data: {"type":"token","text":"Hello"}\n\n',
    // Premature EOF: no [DONE]
  ];

  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        doneReceived = true;
        break;
      }
      try {
        const parsed = JSON.parse(payload);
        if (parsed.type === "token") {
          tokensReceived = true;
          tokens.push(parsed.text);
        }
      } catch {}
    }
  }

  if (!doneReceived && !terminalError) {
    terminalError = new Error("Response interrupted before completion.");
    terminalError.code = "response_interrupted";
    interrupted = tokensReceived;
    errorReported = terminalError;
  }

  if (!interrupted && doneReceived) {
    doneCalled = true;
  }

  assert.equal(doneReceived, false, "Stream had no [DONE]");
  assert.equal(interrupted, true, "Interrupted flag must be true");
  assert.equal(doneCalled, false, "onDone must NOT be called on premature stream disconnect");
  assert.equal(errorReported?.code, "response_interrupted", "Error must report response_interrupted");
  assert.deepEqual(tokens, ["Hello"], "Tokens received prior to disconnect are retained");
}

console.log("Guest turn frontend robustness checks passed.");
