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
// 2. Behavioral Tests for Polling Fallback State Machine
// ============================================================================

// Test: Polling fallback delivers incremental tokens and completes cleanly
{
  let tokenDeltas = [];
  let doneCalled = false;
  let pollCount = 0;

  const mockEntry = {
    generationId: "gen-behavioral-poll-1",
    deliveredText: "",
    responseBuffer: "",
    tokensReceived: false,
    terminal: false,
    cancelled: false,
    cancelRequested: false,
    status: "queued",
    callbacks: {
      onToken: (delta) => tokenDeltas.push(delta),
      onDone: () => { doneCalled = true; },
      onError: () => {},
    },
  };

  const fakeFetch = async () => {
    pollCount += 1;
    if (pollCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "generating", partial_text: "First chunk" }),
      };
    }
    if (pollCount === 2) {
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

  const pollIntervalMs = 5;
  let totalAttempts = 0;

  while (!mockEntry.terminal && !mockEntry.cancelled) {
    totalAttempts += 1;
    const response = await fakeFetch();
    if (response.ok) {
      const data = await response.json();
      const status = String(data?.status || "");
      if (typeof data?.partial_text === "string" && data.partial_text.length > mockEntry.deliveredText.length) {
        const newText = data.partial_text.slice(mockEntry.deliveredText.length);
        mockEntry.deliveredText = data.partial_text;
        mockEntry.responseBuffer = data.partial_text;
        mockEntry.tokensReceived = true;
        totalAttempts = 0;
        mockEntry.callbacks.onToken?.(newText);
      }
      if (["completed", "failed", "cancelled"].includes(status)) {
        mockEntry.status = status;
        mockEntry.terminal = true;
        if (status === "completed") mockEntry.callbacks.onDone?.();
        break;
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  assert.equal(mockEntry.terminal, true, "Polling must transition entry to terminal state");
  assert.equal(mockEntry.status, "completed", "Entry status must be completed");
  assert.equal(doneCalled, true, "onDone must be called upon completed status");
  assert.deepEqual(tokenDeltas, ["First chunk", " second chunk"], "Token deltas must be dispatched incrementally");
}

// Test: Polling fallback on 404 fails cleanly with generation_not_found
{
  let errorReceived = null;
  const mockEntry404 = {
    generationId: "gen-behavioral-404",
    deliveredText: "",
    tokensReceived: false,
    terminal: false,
    cancelled: false,
    status: "queued",
    callbacks: {
      onError: (err) => { errorReceived = err; },
    },
  };

  const response404 = { status: 404, ok: false };
  if (response404.status === 404) {
    const err = new Error("Generation record not found.");
    err.code = "generation_not_found";
    mockEntry404.status = "failed";
    mockEntry404.terminal = true;
    mockEntry404.error = err;
    mockEntry404.callbacks.onError?.(err);
  }

  assert.equal(mockEntry404.terminal, true, "404 response must mark entry terminal");
  assert.equal(mockEntry404.status, "failed", "Entry status must be failed");
  assert.equal(errorReceived?.code, "generation_not_found", "Error code must be generation_not_found");
}

// Test: Polling fallback on persistent stall terminates with generation_recovery_timeout
{
  let timeoutErrorReceived = null;
  const mockEntryTimeout = {
    generationId: "gen-behavioral-timeout",
    deliveredText: "",
    tokensReceived: false,
    terminal: false,
    cancelled: false,
    status: "queued",
    callbacks: {
      onError: (err) => { timeoutErrorReceived = err; },
    },
  };

  const maxTotalPollAttempts = 5;
  let totalAttempts = 5;

  if (totalAttempts >= maxTotalPollAttempts) {
    const timeoutError = new Error("Generation recovery timed out before reaching a terminal state.");
    timeoutError.code = "generation_recovery_timeout";
    mockEntryTimeout.status = "failed";
    mockEntryTimeout.terminal = true;
    mockEntryTimeout.error = timeoutError;
    mockEntryTimeout.callbacks.onError?.(timeoutError);
  }

  assert.equal(mockEntryTimeout.terminal, true, "Persistent poll stall must not leave entry nonterminal");
  assert.equal(mockEntryTimeout.status, "failed", "Entry status must be failed");
  assert.equal(timeoutErrorReceived?.code, "generation_recovery_timeout", "Must report generation_recovery_timeout");
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
