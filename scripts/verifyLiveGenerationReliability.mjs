import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = (process.env.SENTIQ_LIVE_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const enabled = process.env.SENTIQ_LIVE_GENERATION_VERIFY === "true";
const ownerId = process.env.SENTIQ_LIVE_OWNER_ID || `pass5-${randomUUID()}`;
const timeoutMs = Number.parseInt(process.env.SENTIQ_LIVE_TIMEOUT_MS || "90000", 10);
const pollMs = Number.parseInt(process.env.SENTIQ_LIVE_POLL_MS || "1000", 10);

if (!enabled) {
  console.error("REFUSING LIVE GENERATION VERIFICATION: set SENTIQ_LIVE_GENERATION_VERIFY=true explicitly.");
  process.exit(2);
}

assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10000, "SENTIQ_LIVE_TIMEOUT_MS must be >= 10000ms");
assert(Number.isSafeInteger(pollMs) && pollMs >= 100, "SENTIQ_LIVE_POLL_MS must be >= 100ms");

const startedAt = Date.now();
const report = {
  scenario: "guest_live_generation",
  baseUrl,
  ownerIdRedacted: `${ownerId.slice(0, 8)}…`,
  generationId: null,
  clientRequestId: null,
  events: [],
  finalStatus: null,
  sequenceGaps: 0,
  duplicateSequences: 0,
  ok: false,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "X-Sentiq-Anonymous-Id": ownerId,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(Math.min(timeoutMs, 15000)),
  });
  return response;
}

async function waitForTerminal(generationId) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const response = await request(`/api/chat/generations/${generationId}`);
    assert(response.ok, `generation status returned HTTP ${response.status}`);
    const body = await response.json();
    previous = body;
    const status = String(body.status || "");
    if (["completed", "failed", "cancelled"].includes(status)) return body;
    await sleep(pollMs);
  }
  throw new Error(`generation did not reach a terminal state within ${timeoutMs}ms; lastStatus=${String(previous?.status || "unknown")}`);
}

async function readEvents(generationId, after = 0) {
  const response = await request(`/api/chat/generations/${generationId}/events?after=${after}`, {
    headers: { Accept: "text/event-stream" },
  });
  assert(response.ok, `generation events returned HTTP ${response.status}`);
  const text = await response.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && Number.isFinite(Number(parsed.sequence))) events.push(parsed);
    } catch {
      // Ignore keepalive/non-JSON frames.
    }
  }
  return events;
}

try {
  const clientRequestId = `pass5-${randomUUID()}`;
  report.clientRequestId = clientRequestId;
  const conversationId = randomUUID();

  const createResponse = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message: "Pass 5 verification. Reply with PASS5_OK.",
      conversationId,
      clientRequestId,
      executionMode: "fast",
    }),
  });
  assert.equal(createResponse.status, 202, `generation creation returned HTTP ${createResponse.status}`);
  const created = await createResponse.json();
  assert(typeof created.generation_id === "string" && created.generation_id.length > 0, "missing generation_id");
  report.generationId = created.generation_id;

  const duplicateResponse = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message: "Pass 5 verification. Reply with PASS5_OK.",
      conversationId,
      clientRequestId,
      executionMode: "fast",
    }),
  });
  assert.equal(duplicateResponse.status, 202, `duplicate generation request returned HTTP ${duplicateResponse.status}`);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.generation_id, report.generationId, "duplicate clientRequestId created a second generation");

  const terminal = await waitForTerminal(report.generationId);
  report.finalStatus = terminal.status;
  assert.equal(terminal.status, "completed", `live verification generation ended as ${terminal.status}: ${String(terminal.error_code || "unknown")}`);

  const events = await readEvents(report.generationId, 0);
  report.events = events.map((event) => ({ sequence: Number(event.sequence), type: String(event.type || "") }));
  const sequences = events.map((event) => Number(event.sequence)).sort((a, b) => a - b);
  for (let index = 1; index < sequences.length; index += 1) {
    if (sequences[index] === sequences[index - 1]) report.duplicateSequences += 1;
    if (sequences[index] !== sequences[index - 1] + 1) report.sequenceGaps += 1;
  }
  assert.equal(report.duplicateSequences, 0, "durable event replay contained duplicate sequence numbers");
  assert.equal(report.sequenceGaps, 0, "durable event replay contained a sequence gap");
  assert(events.some((event) => event.type === "generation_completed"), "terminal completion event was not replayed");

  report.ok = true;
  report.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify(report));
} catch (error) {
  report.durationMs = Date.now() - startedAt;
  report.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
