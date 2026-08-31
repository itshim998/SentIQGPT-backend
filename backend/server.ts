import { bootProfiler } from "./bootProfiler";
import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";

bootProfiler.mark("process.start");

// Load .env before any service or dbRouter initialization
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
bootProfiler.enable();
bootProfiler.mark("env.loaded");

// Phase 3/4 entrypoint.
// The compatibility bootstrap intercepts chat generation transport before the
// legacy Express application registers its routes. It turns /api/chat and
// /api/chat/stream into generation-aware operations while preserving the
// existing handler as the execution engine during this migration.
import "./chatGenerationTransportBootstrap";
import "./chatGenerationRehydrationRoutes";
import "./chatGenerationSessionRoutes";
import "./serverLegacy";
// Load after the legacy route registration so the generation executor is known;
// the recovery modules then scan durable generations and re-enter runGeneration().
import "./services/generationRecovery";
import "./services/guestGenerationRecovery";

