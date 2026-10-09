import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lifecycleSource = readFileSync("frontend/scripts/generation-lifecycle.js", "utf8");
const apiSource = readFileSync("frontend/scripts/services/api.js", "utf8");

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
  /if\s*\(\s*entry\.subscription\.reconnectAttempts\s*>\s*MAX_RECONNECT_ATTEMPTS\s*\)\s*\{\s*return await pollDurableStatusUntilTerminal/,
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

console.log("Guest turn frontend robustness checks passed.");
