import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = (process.env.SENTIQ_LIVE_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const enabled = process.env.SENTIQ_LIVE_GENERATION_VERIFY === "true";
const ownerId = process.env.SENTIQ_LIVE_OWNER_ID || `pass5-reconnect-${randomUUID()}`;
const timeoutMs = Number.parseInt(process.env.SENTIQ_LIVE_TIMEOUT_MS || "120000", 10);
const pollMs = Number.parseInt(process.env.SENTIQ_LIVE_POLL_MS || "1000", 10);
const reconnectDelayMs = Number.parseInt(process.env.SENTIQ_LIVE_RECONNECT_DELAY_MS || "1500", 10);

if (!enabled) {
  console.error("REFUSING LIVE SSE RECONNECT VERIFICATION: set SENTIQ_LIVE_GENERATION_VERIFY=true explicitly.");
  process.exit(2);
}

assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 30000, "SENTIQ_LIVE_TIMEOUT_MS must be >= 30000ms");
assert(Number.isSafeInteger(pollMs) && pollMs >= 100, "SENTIQ_LIVE_POLL_MS must be >= 100ms");
assert(Number.isSafeInteger(reconnectDelayMs) && reconnectDelayMs >= 0, "SENTIQ_LIVE_RECONNECT_DELAY_MS must be >= 0ms");

const startedAt = Date.now();
const report = {
  scenario: "guest_sse_disconnect_reconnect",
  baseUrl,
  ownerIdRedacted: `${ownerId.slice(0, 8)}…`,
  generationId: null,
  clientRequestId: null,
  firstConnectionSequences: [],
  replayedSequences: [],
  finalStatus: null,
  disconnectedWithoutCancel: false,
  sequenceGaps: 0,
  duplicateSequences: 0,
  ok: false,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "X-Sentiq-Anonymous-Id": ownerId,
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(Math.min(timeoutMs, 15000)),
  });
}

async function waitForRunning(generationId) {
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  let last = null;
  while (Date.now() < deadline) {
    const response = await request(`/api/chat/generations/${generationId}`);
    assert(response.ok, `generation status returned HTTP ${response.status}`);
    last = await response.json();
    if (String(last.status) === "running") return last;
    if (["completed", "failed", "cancelled"].includes(String(last.status))) {
      throw new Error(`generation reached ${last.status} before SSE disconnect test could begin`);
    }
    await sleep(pollMs);
  }
  throw new Error(`generation did not enter running state; lastStatus=${String(last?.status || "unknown")}`);
}

async function waitForTerminal(generationId) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const response = await request(`/api/chat/generations/${generationId}`);
    assert(response.ok, `generation status returned HTTP ${response.status}`);
    previous = await response.json();
    const status = String(previous.status || "");
    if (["completed", "failed", "cancelled"].includes(status)) return previous;
    await sleep(pollMs);
  }
  throw new Error(`generation did not reach terminal state within ${timeoutMs}ms; lastStatus=${String(previous?.status || "unknown")}`);
}

function parseSseBlock(block) {
  const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
  if (!line) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && Number.isFinite(Number(parsed.sequence)) ? parsed : null;
  } catch {
    return null;
  }
}

async function readUntilEvent(response, predicate, signal) {
  assert(response.body, "SSE response body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event && predicate(event)) return event;
      }
      if (signal?.aborted) return null;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

async function connectAndCaptureFirstEvent(generationId, afterSequence) {
  const controller = new AbortController();
  const response = await request(`/api/chat/generations/${generationId}/events?after=${afterSequence}`, {
    headers: {
      Accept: "text/event-stream",
      ...(afterSequence > 0 ? { "Last-Event-ID": String(afterSequence) } : {}),
    },
    signal: controller.signal,
  });
  assert(response.ok, `SSE connection returned HTTP ${response.status}`);
  return { controller, response };
}

try {
  const clientRequestId = `pass5-reconnect-${randomUUID()}`;
  const conversationId = randomUUID();
  report.clientRequestId = clientRequestId;

  const createResponse = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message: "Pass 5 reliability verification. Produce a detailed explanation of distributed generation recovery, using at least 900 words and no tools.",
      conversationId,
      clientRequestId,
      executionMode: "fast",
    }),
  });
  assert.equal(createResponse.status, 202, `generation creation returned HTTP ${createResponse.status}`);
  const created = await createResponse.json();
  assert(typeof created.generation_id === "string" && created.generation_id.length > 0, "missing generation_id");
  report.generationId = created.generation_id;

  await waitForRunning(report.generationId);

  const firstConnection = await connectAndCaptureFirstEvent(report.generationId, 0);
  let lastSeen = 0;
  const firstEvent = await readUntilEvent(
    firstConnection.response,
    (event) => String(event.type || "") !== "generation_snapshot",
    firstConnection.controller.signal,
  );
  assert(firstEvent, "first SSE connection did not deliver a generation event");
  lastSeen = Number(firstEvent.sequence);
  report.firstConnectionSequences.push(lastSeen);
  assert.notEqual(firstEvent.type, "generation_cancelled", "generation was already cancelled on first connection");

  firstConnection.controller.abort();
  await sleep(reconnectDelayMs);

  const statusAfterDisconnectResponse = await request(`/api/chat/generations/${report.generationId}`);
  assert(statusAfterDisconnectResponse.ok, `status after disconnect returned HTTP ${statusAfterDisconnectResponse.status}`);
  const statusAfterDisconnect = await statusAfterDisconnectResponse.json();
  assert.notEqual(statusAfterDisconnect.status, "cancelled", "SSE disconnect cancelled the generation");
  assert.notEqual(statusAfterDisconnect.status, "failed", "generation failed immediately after SSE disconnect");
  report.disconnectedWithoutCancel = true;

  const secondConnection = await connectAndCaptureFirstEvent(report.generationId, lastSeen);
  const replayDeadline = Date.now() + timeoutMs;
  let replayBuffer = "";
  const replayReader = secondConnection.response.body?.getReader();
  assert(replayReader, "reconnect SSE response body is unavailable");
  const decoder = new TextDecoder();
  let terminalSeen = false;
  try {
    while (Date.now() < replayDeadline) {
      const { value, done } = await replayReader.read();
      if (done) break;
      replayBuffer += decoder.decode(value, { stream: true });
      const blocks = replayBuffer.split("\n\n");
      replayBuffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (!event) continue;
        const sequence = Number(event.sequence);
        report.replayedSequences.push(sequence);
        if (sequence <= lastSeen) throw new Error(`reconnect replay returned sequence ${sequence} after cursor ${lastSeen}`);
        if (sequence !== lastSeen + 1) report.sequenceGaps += 1;
        lastSeen = sequence;
        if (["generation_completed", "generation_failed", "generation_cancelled"].includes(String(event.type))) {
          terminalSeen = true;
          break;
        }
      }
      if (terminalSeen) break;
    }
  } finally {
    try { await replayReader.cancel(); } catch {}
  }

  const terminal = await waitForTerminal(report.generationId);
  report.finalStatus = terminal.status;
  assert.equal(report.sequenceGaps, 0, "reconnect stream contained a sequence gap");
  const unique = new Set(report.replayedSequences);
  report.duplicateSequences = report.replayedSequences.length - unique.size;
  assert.equal(report.duplicateSequences, 0, "reconnect stream contained duplicate sequence numbers");
  assert.equal(report.finalStatus, "completed", `generation ended as ${report.finalStatus}`);
  assert(report.replayedSequences.length > 0, "reconnect delivered no events after the original cursor");
  assert(terminal.status !== "cancelled", "generation was cancelled during SSE reconnect verification");

  report.ok = true;
  report.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify(report));
} catch (error) {
  report.durationMs = Date.now() - startedAt;
  report.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
