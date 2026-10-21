import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  createElement: () => ({ dataset: {}, setAttribute: () => {}, classList: { add: () => {}, remove: () => {}, contains: () => false } }),
  documentElement: { dataset: {}, classList: { contains: () => false, add: () => {} } },
  addEventListener: () => {},
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.CustomEvent = class CustomEvent { constructor(name, init) { this.name = name; this.detail = init?.detail; } };
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;

window.SentIQAPI = { sendMessage: () => {}, sendMessageStream: () => {} };
window.__SENTIQ_POLL_INTERVAL_MS = 2; // Fast polling for tests (2ms)
window.__SENTIQ_RECONNECT_BASE_MS = 2; // Fast reconnect for tests (2ms)
window.__SENTIQ_RECONNECT_MAX_MS = 10;

await import("../scripts/generation-lifecycle.js");

const {
  streamFastGeneration,
  streamTwoRequestGeneration,
  reconcileEntryDurableStatus,
  subscribeUntilTerminal,
  createGenerationEntry,
  getActiveGenerations,
} = window.SentIQGenerationLifecycle;

// Helper to create deterministic mock SSE stream response
function createMockStreamResponse({
  headers = {},
  chunks = [],
  throwAfterChunkIndex = -1,
  throwError = new Error("SSE connection reset by peer"),
}) {
  const encoder = new TextEncoder();
  let index = 0;
  const mockReader = {
    async read() {
      if (throwAfterChunkIndex >= 0 && index > throwAfterChunkIndex) {
        throw throwError;
      }
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }
      const chunkText = chunks[index++];
      return { done: false, value: encoder.encode(chunkText) };
    },
    async cancel() {},
    releaseLock() {},
  };
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => headers[name.toLowerCase()] || headers[name] || null,
    },
    body: {
      getReader: () => mockReader,
    },
    json: async () => ({}),
  };
}

console.log("Running SentIQ Chat Generation Stream Recovery Regression Suite...");

// ============================================================================
// Test 1: Normal stream containing tokens and completion event completes normally
// ============================================================================
{
  const genId = "gen-test-1-normal";
  let tokenCount = 0;
  let doneCount = 0;

  globalThis.fetch = async (url) => {
    return createMockStreamResponse({
      headers: { "x-generation-id": genId },
      chunks: [
        'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
        'data: {"type":"token","text":"Hello "}\n\n',
        'data: {"type":"token","text":"world!"}\n\n',
        'data: {"type":"generation_completed","generation_id":"' + genId + '","status":"completed"}\n\n',
        "data: [DONE]\n\n",
      ],
    });
  };

  const result = await streamFastGeneration("Hello", { executionMode: "fast" }, {
    onToken: () => { tokenCount++; },
    onDone: () => { doneCount++; },
  });

  assert.equal(result.interrupted, false, "Normal stream must not be interrupted");
  assert.equal(result.cancelled, false, "Normal stream must not be cancelled");
  assert.equal(result.tokensReceived, true, "Tokens were received");
  assert.equal(result.completed, true, "Result confirms completion");
  assert.equal(result.error, null, "Error must be null");
  assert.equal(tokenCount, 2, "Both tokens delivered");
  assert.equal(doneCount, 1, "onDone delivered exactly once");
}

// ============================================================================
// Test 2: CORE RECOVERY — Reader throws after all visible tokens, but durable
//         generation status confirms completion.
//         The lifecycle recovers and reports successful completion!
// ============================================================================
{
  const genId = "gen-test-2-durable-recovery";
  let tokensReceivedList = [];
  let doneDispatchedCount = 0;
  let durableFetchCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url || "");
    if (urlStr.includes("/api/chat/stream")) {
      return createMockStreamResponse({
        headers: { "x-generation-id": genId },
        chunks: [
          'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
          'data: {"type":"token","text":"Artificial "}\n\n',
          'data: {"type":"token","text":"Intelligence"}\n\n',
          // Stream drops abruptly here! No [DONE], no generation_completed over SSE!
        ],
        throwAfterChunkIndex: 2, // Throws after both tokens are read
        throwError: new Error("Network error: connection reset by peer"),
      });
    }

    if (urlStr.includes(`/api/chat/generations/${genId}`)) {
      durableFetchCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "completed",
          completed_at: new Date().toISOString(),
          partial_text: "Artificial Intelligence",
        }),
      };
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  const result = await streamFastGeneration("Tell me about AI", { executionMode: "fast" }, {
    onToken: (t) => { tokensReceivedList.push(t); },
    onDone: () => { doneDispatchedCount++; },
  });

  assert.deepEqual(tokensReceivedList, ["Artificial ", "Intelligence"], "All visible tokens arrived before failure");
  assert.equal(durableFetchCount > 0, true, "Durable status was fetched to reconcile terminal state");
  assert.equal(result.interrupted, false, "Recovered generation must NOT be marked interrupted");
  assert.equal(result.cancelled, false, "Recovered generation must NOT be cancelled");
  assert.equal(result.completed, true, "Result must report completed: true");
  assert.equal(result.status, "completed", "Status must be completed");
  assert.equal(result.error, null, "Error must be cleared on successful recovery");
  assert.equal(doneDispatchedCount, 1, "onDone callback must be delivered exactly once");
}

// ============================================================================
// Test 3: SSE EVENT RECOVERY — Reader throws after visible tokens, and the
//         reconnecting event subscription receives generation_completed.
//         The completion callback is delivered exactly once.
// ============================================================================
{
  const genId = "gen-test-3-sse-recovery";
  let tokensDelivered = [];
  let onDoneDeliveredCount = 0;
  let sseEventStreamCalled = false;

  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url || "");
    if (urlStr.includes("/api/chat/stream")) {
      return createMockStreamResponse({
        headers: { "x-generation-id": genId },
        chunks: [
          'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
          'data: {"type":"token","text":"Quantum "}\n\n',
          'data: {"type":"token","text":"Computing"}\n\n',
        ],
        throwAfterChunkIndex: 2,
        throwError: new TypeError("Failed to fetch"),
      });
    }

    // Durable check initially returns running (still finishing in background)
    if (urlStr.endsWith(`/api/chat/generations/${genId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "running" }),
      };
    }

    // Reconnecting event stream delivers completion event
    if (urlStr.includes(`/api/chat/generations/${genId}/events`)) {
      sseEventStreamCalled = true;
      return createMockStreamResponse({
        chunks: [
          'data: {"type":"generation_completed","generation_id":"' + genId + '","status":"completed"}\n\n',
          "data: [DONE]\n\n",
        ],
      });
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  const result = await streamFastGeneration("Tell me about Quantum", { executionMode: "fast" }, {
    onToken: (t) => { tokensDelivered.push(t); },
    onDone: () => { onDoneDeliveredCount++; },
  });

  assert.equal(sseEventStreamCalled, true, "Event stream was reconnected after durable status was still running");
  assert.equal(result.interrupted, false, "Must not be interrupted when SSE reconnection confirms completed");
  assert.equal(result.completed, true, "Must confirm completed");
  assert.equal(onDoneDeliveredCount, 1, "onDone delivered exactly once");
}

// ============================================================================
// Test 4: Reader throws while the backend confirms that the generation failed.
//         The real failure is preserved.
// ============================================================================
{
  const genId = "gen-test-4-failure";
  let onErrorDelivered = null;

  globalThis.fetch = async (url) => {
    const urlStr = String(url || "");
    if (urlStr.includes("/api/chat/stream")) {
      return createMockStreamResponse({
        headers: { "x-generation-id": genId },
        chunks: [
          'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
          'data: {"type":"token","text":"Starting task..."}\n\n',
        ],
        throwAfterChunkIndex: 1,
        throwError: new Error("Transport failed"),
      });
    }

    if (urlStr.includes(`/api/chat/generations/${genId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "failed",
          error_code: "provider_overloaded",
          failed_at: new Date().toISOString(),
        }),
      };
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  const result = await streamFastGeneration("Prompt", { executionMode: "fast" }, {
    onError: (err) => { onErrorDelivered = err; },
  });

  assert.equal(result.interrupted, true, "Failed generation must be reported as interrupted");
  assert.equal(result.completed, undefined, "Must not be reported as completed");
  assert.equal(result.error?.code, "provider_overloaded", "Real failure error code must be preserved");
  assert.equal(onErrorDelivered?.code, "provider_overloaded", "onError must receive real failure code");
}

// ============================================================================
// Test 5: Reader throws while the backend confirms cancellation.
//         Cancellation semantics are preserved.
// ============================================================================
{
  const genId = "gen-test-5-cancelled";
  let onCancelledDelivered = false;

  globalThis.fetch = async (url) => {
    const urlStr = String(url || "");
    if (urlStr.includes("/api/chat/stream")) {
      return createMockStreamResponse({
        headers: { "x-generation-id": genId },
        chunks: [
          'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
          'data: {"type":"token","text":"Partial..."}\n\n',
        ],
        throwAfterChunkIndex: 1,
        throwError: new Error("Transport drop"),
      });
    }

    if (urlStr.includes(`/api/chat/generations/${genId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
        }),
      };
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  const result = await streamFastGeneration("Prompt", { executionMode: "fast" }, {
    onCancelled: () => { onCancelledDelivered = true; },
  });

  assert.equal(result.cancelled, true, "Must be marked cancelled: true");
  assert.equal(result.interrupted, false, "Cancelled generation is not interrupted");
  assert.equal(onCancelledDelivered, true, "onCancelled callback delivered");
}

// ============================================================================
// Test 6: Terminal status remains unknown after bounded recovery.
//         The response remains recoverable and is NOT marked complete.
// ============================================================================
{
  const genId = "gen-test-6-unconfirmed";
  let errorCaught = null;

  globalThis.fetch = async (url) => {
    const urlStr = String(url || "");
    if (urlStr.includes("/api/chat/stream")) {
      return createMockStreamResponse({
        headers: { "x-generation-id": genId },
        chunks: [
          'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
          'data: {"type":"token","text":"Incomplete answer"}\n\n',
        ],
        throwAfterChunkIndex: 1,
        throwError: new Error("Socket hung up"),
      });
    }

    // Server returns 500 on all status and event endpoints
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal Server Error" }),
    };
  };

  const result = await streamFastGeneration("Prompt", { executionMode: "fast" }, {
    onError: (err) => { errorCaught = err; },
  });

  assert.equal(result.interrupted, true, "Unconfirmed terminal status must retain interrupted: true");
  assert.notEqual(result.status, "completed", "Must NOT pretend to be completed");
  assert.ok(result.error != null, "Must have an error attached");
  assert.ok(
    result.error?.code === "generation_unconfirmed" || result.error?.code === "generation_recovery_timeout",
    `Must report generation_unconfirmed or generation_recovery_timeout, got: ${result.error?.code}`
  );
}

// ============================================================================
// Test 7: A genuinely aborted request does not enter completion-recovery
// ============================================================================
{
  const genId = "gen-test-7-abort";
  const ac = new AbortController();
  let fetchCalledAfterAbort = false;

  globalThis.fetch = async (url) => {
    const urlStr = String(url || "");
    if (urlStr.includes("/api/chat/stream")) {
      return createMockStreamResponse({
        headers: { "x-generation-id": genId },
        chunks: [
          'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
          'data: {"type":"token","text":"Token 1"}\n\n',
        ],
        throwAfterChunkIndex: 1,
        throwError: (() => {
          ac.abort();
          const err = new Error("The user aborted a request.");
          err.name = "AbortError";
          return err;
        })(),
      });
    }

    fetchCalledAfterAbort = true;
    return { ok: true, status: 200, json: async () => ({ status: "completed" }) };
  };

  let caughtErr = null;
  try {
    await streamFastGeneration("Prompt", { executionMode: "fast" }, {}, ac.signal);
  } catch (err) {
    caughtErr = err;
  }

  assert.equal(caughtErr?.name, "AbortError", "AbortError must be propagated");
  assert.equal(fetchCalledAfterAbort, false, "Aborted request must NOT query durable completion endpoints");
}

// ============================================================================
// Test 8: An exception from an application callback is not misclassified
//         as a transport error.
// ============================================================================
{
  const genId = "gen-test-8-app-error";
  let networkRecoveryAttempted = false;

  globalThis.fetch = async (url) => {
    const urlStr = String(url || "");
    if (urlStr.includes("/api/chat/stream")) {
      return createMockStreamResponse({
        headers: { "x-generation-id": genId },
        chunks: [
          'data: {"type":"generation_started","generation_id":"' + genId + '"}\n\n',
          'data: {"type":"token","text":"Token 1"}\n\n',
        ],
      });
    }
    networkRecoveryAttempted = true;
    return { ok: true, status: 200, json: async () => ({ status: "completed" }) };
  };

  const appError = new TypeError("Custom application callback exception in UI renderer");
  let caught = null;

  try {
    await streamFastGeneration("Prompt", { executionMode: "fast" }, {
      onToken: () => {
        throw appError;
      },
    });
  } catch (err) {
    caught = err;
  }

  assert.equal(caught, appError, "Exact application callback exception must bubble out");
  assert.equal(caught.__sentiqApplicationCallback, true, "Must be tagged as application callback error");
  assert.equal(networkRecoveryAttempted, false, "Application callback exception must NOT trigger network recovery");
}

// ============================================================================
// Test 9: UI & Persistence Agreement Simulation
//         Confirmed complete -> streamDraft.finalize(fullReply, { responseStatus: "complete" })
//         Interrupted -> streamDraft.markIncomplete(fullReply, "interrupted")
//         Action bar is visible ONLY for confirmed complete.
// ============================================================================
{
  function simulateChatControllerFlow({ streamResult, streamErr, streamPhase = "stream" }) {
    let interruptionNoticePassed = null;
    let draftFinalizeCalled = null;
    let draftMarkIncompleteCalled = null;
    let recoveryRowAppended = null;
    let actionBarCompleteCalled = false;

    const streamBubble = {
      getFullText: () => "Rendered text answer from LLM",
      finish: async (options = {}) => {
        interruptionNoticePassed = options.interruptionNotice || null;
        if (!interruptionNoticePassed) {
          actionBarCompleteCalled = true;
        }
      },
    };

    const streamDraft = {
      finalize: async (text, meta) => {
        draftFinalizeCalled = { text, meta };
      },
      markIncomplete: async (text, status, meta) => {
        draftMarkIncompleteCalled = { text, status, meta };
      },
    };

    const appendRecoveryRow = (container, opts) => {
      recoveryRowAppended = opts;
    };

    // Execute chat-controller error and finalization routing:
    if (streamErr) {
      if (streamErr.name === "AbortError") {
        streamBubble.finish({ interruptionNotice: "Stopped. Partial answer saved." });
        const partial = streamBubble.getFullText();
        streamDraft.markIncomplete(partial, "stopped", {});
        appendRecoveryRow({}, { responseStatus: "stopped" });
      } else if (streamPhase === "post_stream") {
        streamBubble.finish();
      } else {
        streamBubble.finish({ interruptionNotice: "Streaming interrupted." });
        const partial = streamBubble.getFullText();
        const failedStatus = (streamErr?.code === "generation_unconfirmed") ? "unconfirmed" : "interrupted";
        streamDraft.markIncomplete(partial, failedStatus, {});
        appendRecoveryRow({}, { responseStatus: failedStatus });
      }
    } else if (streamResult?.cancelled) {
      streamBubble.finish({ interruptionNotice: "Stopped. Partial answer saved." });
      const partial = streamBubble.getFullText();
      streamDraft.markIncomplete(partial, "stopped", {});
      appendRecoveryRow({}, { responseStatus: "stopped" });
    } else if (streamResult?.interrupted) {
      streamBubble.finish({ interruptionNotice: "Streaming interrupted." });
      const partial = streamBubble.getFullText();
      const failedStatus = (streamResult?.error?.code === "generation_unconfirmed") ? "unconfirmed" : "interrupted";
      streamDraft.markIncomplete(partial, failedStatus, {});
      appendRecoveryRow({}, { responseStatus: failedStatus });
    } else {
      // Confirmed complete:
      streamBubble.finish();
      const fullReply = streamBubble.getFullText();
      streamDraft.finalize(fullReply, { responseStatus: "complete", type: "text" });
    }

    return {
      interruptionNoticePassed,
      draftFinalizeCalled,
      draftMarkIncompleteCalled,
      recoveryRowAppended,
      actionBarCompleteCalled,
    };
  }

  // 9.1 Successful completion after recovery:
  const successFlow = simulateChatControllerFlow({
    streamResult: { completed: true, tokensReceived: true, interrupted: false, cancelled: false, error: null },
  });
  assert.equal(successFlow.interruptionNoticePassed, null, "Successful completion must NOT pass interruption notice");
  assert.equal(successFlow.recoveryRowAppended, null, "Successful completion must NOT append recovery row");
  assert.equal(successFlow.actionBarCompleteCalled, true, "Action bar must be marked complete on successful finalization");
  assert.equal(successFlow.draftFinalizeCalled?.meta?.responseStatus, "complete", "Persisted draft metadata must be complete");
  assert.equal(successFlow.draftMarkIncompleteCalled, null, "markIncomplete must not be called on completion");

  // 9.2 Truly interrupted stream:
  const interruptedFlow = simulateChatControllerFlow({
    streamResult: { interrupted: true, tokensReceived: true, error: new Error("Disconnected") },
  });
  assert.equal(interruptedFlow.interruptionNoticePassed, "Streaming interrupted.", "Interrupted stream must pass interruption notice");
  assert.equal(interruptedFlow.actionBarCompleteCalled, false, "Action bar must remain HIDDEN on interruption");
  assert.equal(interruptedFlow.draftMarkIncompleteCalled?.status, "interrupted", "Must persist responseStatus: 'interrupted'");
  assert.equal(interruptedFlow.draftFinalizeCalled, null, "Must NOT finalize draft as complete on interruption");
  assert.equal(interruptedFlow.recoveryRowAppended?.responseStatus, "interrupted", "Must append recovery row with status interrupted");

  // 9.3 User cancelled stream:
  const cancelledFlow = simulateChatControllerFlow({
    streamResult: { cancelled: true, tokensReceived: true },
  });
  assert.equal(cancelledFlow.interruptionNoticePassed, "Stopped. Partial answer saved.");
  assert.equal(cancelledFlow.actionBarCompleteCalled, false, "Action bar must remain HIDDEN when stopped");
  assert.equal(cancelledFlow.draftMarkIncompleteCalled?.status, "stopped", "Must persist responseStatus: 'stopped'");
  assert.equal(cancelledFlow.recoveryRowAppended?.responseStatus, "stopped", "Must append recovery row with status stopped");

  // 9.4 Post-stream error after successful generation:
  const postStreamErrorFlow = simulateChatControllerFlow({
    streamErr: new Error("IndexedDB commit failed"),
    streamPhase: "post_stream",
  });
  assert.equal(postStreamErrorFlow.interruptionNoticePassed, null, "Post-stream error must NOT show Streaming interrupted.");
  assert.equal(postStreamErrorFlow.actionBarCompleteCalled, true, "Action bar remains unlocked because generation completed");
}

console.log("All generation stream recovery regression tests passed cleanly!");
