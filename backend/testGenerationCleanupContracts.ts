import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const runner = fs.readFileSync(path.join(root, "backend/services/generationRunner.ts"), "utf8");
const executor = fs.readFileSync(path.join(root, "backend/services/chatGenerationExecutor.ts"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "backend/services/chatGenerationTaskCoordinator.ts"), "utf8");
const bootstrap = fs.readFileSync(path.join(root, "backend/chatGenerationTransportBootstrap.ts"), "utf8");
const renderRouter = fs.readFileSync(path.join(root, "frontend/scripts/generation-render-router.js"), "utf8");
const rehydration = fs.readFileSync(path.join(root, "frontend/scripts/generation-rehydration.js"), "utf8");

assert.match(runner, /executeChatGeneration\(request, sink\)/);
assert.doesNotMatch(runner, /registeredExecutions|defaultGenerationExecutor/);
assert.match(executor, /registerChatGenerationExecutor/);
assert.match(executor, /Generation execution is transport-neutral/);
assert.match(bootstrap, /registerChatGenerationExecutor\(_legacyFinalHandler\)/);
assert.match(bootstrap, /liveExecutionSnapshot: context\.liveSnapshot/);
assert.match(coordinator, /liveExecutionSnapshot/);
assert.match(renderRouter, /rehydrateGeneration/);
assert.match(renderRouter, /subscribeRehydratedGeneration/);
assert.match(renderRouter, /after/);
assert.match(rehydration, /registry\.rehydrateGeneration/);
assert.doesNotMatch(rehydration, /if \(!local\) continue/);

console.log("Generation cleanup contract checks passed.");
