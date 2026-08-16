import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lifecycle = fs.readFileSync(new URL("../scripts/generation-lifecycle.js", import.meta.url), "utf8");
const bootstrap = fs.readFileSync(new URL("../scripts/bootstrap-guard.js", import.meta.url), "utf8");

test("Phase 4 lifecycle adapter uses durable generation endpoints", () => {
  assert.match(lifecycle, /API\.sendMessage\(message/);
  assert.match(lifecycle, /\/api\/chat\/generations\/\$\{encodeURIComponent\(entry\.generationId\)\}\/events/);
  assert.match(lifecycle, /\/api\/chat\/generations\/\$\{encodeURIComponent\(generationId\)\}\/cancel/);
  assert.match(lifecycle, /\/api\/chat\/generations\/cancel-all/);
});

test("Phase 4 lifecycle distinguishes Stop and transport teardown", () => {
  assert.match(lifecycle, /closest\("#send-btn"\)/);
  assert.match(lifecycle, /classList\.contains\("is-stop"\)/);
  assert.match(lifecycle, /entry\.cancelRequested = true/);
  assert.match(lifecycle, /pagehide/);
  assert.match(lifecycle, /beforeunload/);
  assert.match(lifecycle, /AbortError/);
  assert.match(lifecycle, /detached/);
});

test("Phase 4 lifecycle retries transient SSE disconnects", () => {
  assert.match(lifecycle, /MAX_RECONNECT_ATTEMPTS/);
  assert.match(lifecycle, /RECONNECT_BASE_MS/);
  assert.match(lifecycle, /after/);
  assert.match(lifecycle, /subscribeUntilTerminal/);
});

test("bootstrap loads the lifecycle adapter after UI readiness", () => {
  assert.match(bootstrap, /sentiq-ui-ready/);
  assert.match(bootstrap, /generation-lifecycle\.js/);
});
