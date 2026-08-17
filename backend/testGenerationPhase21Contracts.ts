import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const generationMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260816150000_add_chat_generations.sql"),
  "utf8",
);
const hardeningMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260817103000_harden_chat_generation_idempotency.sql"),
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

// Existing schema-level invariant: one logical request can map to one generation.
assert.match(generationMigration, /chat_generations_user_client_request_id_unique/);
assert.match(generationMigration, /on conflict \(user_id, client_request_id\)/);

// Phase 21 hardening: concurrent callers converge through one database operation.
assert.match(hardeningMigration, /get_or_create_chat_generation/);
assert.match(hardeningMigration, /pg_advisory_xact_lock/);
assert.match(hardeningMigration, /where user_id = p_user_id/);
assert.match(hardeningMigration, /client_request_id = v_request_id/);
assert.match(hardeningMigration, /return v_row/);

// Service layer still exposes lookup-by-client-request-id and retains the
// unique-violation fallback for compatibility with pre-migration deployments.
assert.match(service, /getChatGenerationByClientRequestId/);
assert.match(service, /23505/);
assert.match(service, /duplicate: true/);

// The transport must not create a second generation for a completed request.
assert.match(transport, /getChatGenerationByClientRequestId/);
assert.match(transport, /generation\.id/);
assert.match(transport, /\[\"completed\", \"failed\", \"cancelled\"\]/);

// Phase 16 execution lease provides the second line of defense: even when a
// retry reaches another backend process, only one worker can own execution.
assert.match(leaseMigration, /claim_chat_generation_execution/);
assert.match(leaseMigration, /execution_lease_id/);

console.log("Generation Phase 21 duplicate-send/idempotency contract checks passed.");
