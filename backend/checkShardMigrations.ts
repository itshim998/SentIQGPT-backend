import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";

const envPathCandidates = [
  pathResolve(__dirname, "..", ".env"),
  pathResolve(__dirname, "..", "..", ".env"),
  pathResolve(process.cwd(), ".env"),
];
const resolvedEnvPath = envPathCandidates.find((p) => existsSync(p));
if (resolvedEnvPath) {
  dotenv.config({ path: resolvedEnvPath });
} else {
  dotenv.config();
}

(async () => {
  const { verifyShardMigrations } = await import("./dbRouter");
  await verifyShardMigrations();
  console.log("[SentIQ Chat] Shard migration verification passed.");
})().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[SentIQ Chat] Shard migration verification failed: ${message}`);
  process.exit(1);
});
