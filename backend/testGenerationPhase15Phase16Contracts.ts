import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const refreshMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260817092000_add_generation_session_reload_grace.sql"), "utf8");
const reuseMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260817095000_fix_generation_session_reload_reuse_scope.sql"), "utf8");
const leaseMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260817090000_add_generation_execution_leases.sql"), "utf8");
const recovery = fs.readFileSync(path.join(root, "backend/services/generationRecovery.ts"), "utf8");
const runner = fs.readFileSync(path.join(root, "backend/services/generationRunner.ts"), "utf8");
const server = fs.readFileSync(path.join(root, "backend/server.ts"), "utf8");
const sessionRoute = fs.readFileSync(path.join(root, "backend/chatGenerationSessionRoutes.ts"), "utf8");

assert.match(refreshMigration, /close_grace_expires_at/);
assert.match(refreshMigration, /12 seconds/);
assert.match(reuseMigration, /close_grace_expires_at is not null/);
assert.match(reuseMigration, /Two simultaneously open tabs/);

assert.match(leaseMigration, /execution_lease_id/);
assert.match(leaseMigration, /execution_lease_expires_at/);
assert.match(leaseMigration, /recovery_attempts/);
assert.match(leaseMigration, /claim_chat_generation_execution/);
assert.match(leaseMigration, /mark_chat_generation_recoverable/);

assert.match(recovery, /recoverStaleGenerations/);
assert.match(recovery, /STALE_EXECUTION_MS = 75_000/);
assert.match(recovery, /runGeneration\(row.id\)/);
assert.match(server, /generationRecovery/);
assert.match(runner, /claimChatGenerationExecution/);
assert.match(runner, /releaseChatGenerationExecutionLease/);
assert.match(runner, /renewChatGenerationExecutionLease/);
assert.match(sessionRoute, /close_pending: true/);
assert.doesNotMatch(sessionRoute, /requestCancel\(String\(row\.id\)\)/);

console.log("Generation Phase 15/16 contract checks passed.");
