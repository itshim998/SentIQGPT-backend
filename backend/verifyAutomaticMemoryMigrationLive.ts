import "dotenv/config";
import { verifyAutomaticMemoryIdempotencyMigration } from "./dbRouter";

verifyAutomaticMemoryIdempotencyMigration()
  .then(() => {
    console.log("PASS | automatic memory idempotency schema version 20260715120000 is active on shards 2-4.");
  })
  .catch((error) => {
    console.error(JSON.stringify({
      status: "FAIL",
      prerequisite: "automatic_memory_idempotency_migration",
      error_class: error instanceof Error ? error.name : "Error",
    }));
    process.exitCode = 1;
  });
