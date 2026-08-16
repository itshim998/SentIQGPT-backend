import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const bootstrap = fs.readFileSync(path.join(root, "backend/chatGenerationTransportBootstrap.ts"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "backend/services/chatGenerationTaskCoordinator.ts"), "utf8");
const lifecycle = fs.readFileSync(path.join(root, "backend/streamDisconnectLifecycle.ts"), "utf8");
const server = fs.readFileSync(path.join(root, "backend/server.ts"), "utf8");

assert.match(server, /chatGenerationTransportBootstrap/);
assert.match(server, /serverLegacy/);
assert.match(bootstrap, /\/api\/chat\/stream/);
assert.match(bootstrap, /\/api\/chat\/generations\/\:generationId\/events/);
assert.match(bootstrap, /\/api\/chat\/generations\/\:generationId\/cancel/);
assert.match(bootstrap, /\/api\/chat\/generations\/cancel-all/);
assert.match(bootstrap, /startLegacyGeneration/);
assert.match(bootstrap, /__sentiqGenerationDetached/);
assert.match(coordinator, /subscribers/);
assert.match(coordinator, /request\.emit\("sentiq-generation-cancel"\)/);
assert.match(coordinator, /checkpointChatGeneration/);
assert.match(lifecycle, /sentiq-generation-cancel/);
assert.match(lifecycle, /Generation-owned transport close/);
assert.doesNotMatch(lifecycle, /request\.close.*abort/i);

console.log("Chat generation transport phase 3/4 contract checks passed.");
