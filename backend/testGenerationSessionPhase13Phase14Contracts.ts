import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260817080000_add_generation_sessions.sql"), "utf8");
const sessionRoute = fs.readFileSync(path.join(root, "backend/chatGenerationSessionRoutes.ts"), "utf8");
const sessionService = fs.readFileSync(path.join(root, "backend/services/chatGenerationSessionService.ts"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "backend/services/chatGenerationTaskCoordinator.ts"), "utf8");
const browserSession = fs.readFileSync(path.join(root, "frontend/scripts/generation-session.js"), "utf8");
const bootstrap = fs.readFileSync(path.join(root, "frontend/scripts/bootstrap-guard.js"), "utf8");

assert.match(migration, /generation_session_id/);
assert.match(migration, /chat_generation_sessions/);
assert.match(migration, /attach_latest_generation_session/);
assert.match(migration, /expire_stale_chat_generation_sessions/);
assert.match(migration, /cancel_generations_for_session/);

assert.match(sessionRoute, /\/api\/chat\/generation-sessions/);
assert.match(sessionRoute, /heartbeat/);
assert.match(sessionRoute, /close/);
assert.match(sessionRoute, /requestCancel/);
assert.match(sessionService, /openChatGenerationSession/);
assert.match(sessionService, /heartbeatChatGenerationSession/);
assert.match(sessionService, /closeChatGenerationSession/);
assert.match(coordinator, /SESSION_LEASE_SECONDS = 45/);
assert.match(coordinator, /sweepExpiredGenerationSessions/);
assert.match(coordinator, /generationSessionId/);

assert.match(browserSession, /generation_session_id/);
assert.match(browserSession, /keepalive: true/);
assert.match(browserSession, /setInterval/);
assert.match(browserSession, /pagehide/);
assert.match(browserSession, /SentIQGenerationSession/);
assert.match(bootstrap, /generation-session\.js/);
assert.ok(bootstrap.indexOf('generation-session.js') < bootstrap.indexOf('generation-lifecycle.js'));

console.log("Generation session Phase 13/14 contract checks passed.");
