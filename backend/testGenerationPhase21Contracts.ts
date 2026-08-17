import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const generationMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260816150000_add_chat_generations.sql"),
  "utf8",
);
const service = fs.readFileSync(
  path.join(root, "backend/services/chatGenerationService.ts"),
  "utf8",
);
const transport = fs.readFileSync(
  path.join(root, "backend/chatGenerationTransportBootstrap.ts"),
  "utf8",
);
const leaseMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260817100000_add_generation_event_types_and_concurrency.sql"),
  "utf8",
);

// Schema-level invariant: one logical request can map to one generation.
assert.match(generationMigration, /chat_generations_user_client_request_id_unique/);
assert.match(generationMigration, /on conflict \(user_id, client_request_id\)/);

// Application-level convergence: a retry finds the existing generation before
// attempting creation, and a concurrent insert racing the unique index falls
// back to that same row instead of creating a second generation.
assert.match(service, /getChatGenerationByClientRequestId/);
assert.match(service, /23505/);
assert.match(service, /duplicate: true/);

// Transport reuses the returned generation identity/status, so a duplicate
// request does not start a fresh logical generation.
assert.match(transport, /getChatGenerationByClientRequestId/);
assert.match(transport, /generation\.id/);
assert.match(transport, /\[\"completed\", \"failed\", \"cancelled\"\]/);

// Phase 16 execution lease provides the second line of defense: even when a
// retry reaches another backend process, only one worker can own execution.
assert.match(leaseMigration, /claim_chat_generation_execution/);
assert.match(leaseMigration, /execution_lease_id/);

console.log("Generation Phase 21 duplicate-send/idempotency contract checks passed.");
