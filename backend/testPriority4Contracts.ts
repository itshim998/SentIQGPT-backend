import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const server = read("backend/server.ts");
const apiClient = read("frontend/scripts/services/api.js");
const chatController = read("frontend/scripts/features/chat-controller.js");
const schemas = read("backend/validation/schemas.ts");
// Historical internal report filename retained as a static test fixture reference.
const report = read("SentIQGPT_Problems.txt");

function sourceBlock(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${startNeedle} should exist`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${endNeedle} should follow ${startNeedle}`);
  return source.slice(start, end);
}

const streamRoute = sourceBlock(
  server,
  '"/api/chat/stream"',
  "// ===============================\n// POST /api/memory/classify",
);

assert.match(server, /"\/api\/chat\/intent"/, "backend must expose chat intent preflight");
assert.match(server, /type DegradedStatus/, "backend must define the additive degraded-state contract");
assert.match(server, /function buildDegradedStatus/, "backend must derive degraded state from sync status");
assert.match(server, /degraded: buildDegradedStatus\(sync\)/, "chat responses must include degraded metadata");

assert.doesNotMatch(
  streamRoute,
  /res\.json\(/,
  "accepted /api/chat/stream paths must emit SSE instead of mid-route JSON responses",
);
assert.match(
  streamRoute,
  /type: "structured_response"/,
  "stream route must emit structured orchestrator responses as SSE events",
);
assert.match(
  streamRoute,
  /writeStructuredResponse\(buildStreamStructuredPayload/,
  "structured stream responses must include sync/degraded metadata",
);

assert.match(apiClient, /async function getChatIntent/, "frontend API must call backend intent preflight");
assert.match(apiClient, /\/api\/chat\/intent/, "frontend API must target the backend intent endpoint");
assert.match(apiClient, /parsed\.type === "structured_response"/, "frontend stream parser must handle structured_response events");
assert.match(apiClient, /callbacks\.onStructuredResponse\(parsed\.response\)/, "structured SSE payload must reach chat controller");

assert.match(chatController, /let currentSessionFiles = \[\]/, "frontend must track multiple session files");
assert.match(chatController, /sessionFiles: \[\]/, "per-chat state must include sessionFiles");
assert.match(chatController, /function addCurrentSessionFiles/, "file uploads must append to per-chat file context");
assert.match(chatController, /\.slice\(-10\)[\s\S]*\.map\(\(file\) => \(\{[\s\S]*analysis_id:[\s\S]*size_bytes:[\s\S]*mime_type:/, "file references must send up to 10 metadata-rich files");
assert.match(schemas, /analysis_id: z\.string\(\)\.optional\(\)/, "backend schema must accept file analysis ids");
assert.match(schemas, /size_bytes: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/, "backend schema must accept file sizes");
assert.match(schemas, /mime_type: z\.string\(\)\.optional\(\)/, "backend schema must accept file mime types");

assert.match(chatController, /meta\?\.type === "file-upload"/, "frontend sync serialization must preserve file-upload metadata");
assert.match(server, /messageType: "file_upload"/, "chat sync must persist file-upload message type");
assert.match(server, /message\.meta\?\.type === "file-upload"/, "chat sync must keep upload-only messages");
assert.match(chatController, /messageType === "file_upload"/, "server file-upload messages must hydrate back to frontend metadata");
assert.match(chatController, /processSyncQueue\(\)\.catch/, "upload-only file messages must trigger sync processing");

assert.doesNotMatch(
  report,
  /Priority 4 - Reduce route\/contract drift/,
  "Priority 4 roadmap block should be removed after implementation",
);

console.log("PASS | Priority 4 route, degraded-state, streaming, and file-context contracts passed.");
