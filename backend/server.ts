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
