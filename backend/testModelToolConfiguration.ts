import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CANONICAL_SENTIQ_MODEL_TOOL_ENV_NAMES,
  OBSOLETE_SENTIQ_MODEL_TOOL_ENV_NAMES,
} from "./ai/modelToolCapability";

const expected = [
  "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
  "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
] as const;

assert.deepEqual(CANONICAL_SENTIQ_MODEL_TOOL_ENV_NAMES, expected);

const authoritativeSurfaces = [
  ".env.example",
  ".env.template",
  "ENVIRONMENT_VARIABLES.md",
  "AZURE_DEPLOYMENT_GUIDE.md",
  ".github/workflows/azure-container-apps.yml",
  "docs/ai/model-native-request-cost.md",
  "docs/ai/model-native-tool-verification.md",
];
for (const path of authoritativeSurfaces) {
  const source = readFileSync(path, "utf8");
  for (const name of expected) assert.match(source, new RegExp(`\\b${name}\\b`), `${path} is missing ${name}`);
  for (const obsolete of OBSOLETE_SENTIQ_MODEL_TOOL_ENV_NAMES) {
    assert.doesNotMatch(source, new RegExp(`\\b${obsolete}\\b`), `${path} contains obsolete ${obsolete}`);
  }
}

const python = readFileSync("llm_adapter.py", "utf8");
for (const name of expected) assert.match(python, new RegExp(`\"${name}\"`), `Python parity is missing ${name}`);
assert.match(python, /parameters_json_schema=input_schema/);
assert.doesNotMatch(python, /google\.generativeai|GenerativeModel\(/);

const requirements = readFileSync("requirements.txt", "utf8");
assert.match(requirements, /^google-genai>=/m);
assert.doesNotMatch(requirements, /^google-generativeai/m);
JSON.parse(readFileSync("backend/fixtures/modelToolCapabilityParity.json", "utf8"));
assert.match(readFileSync("backend/testModelToolTransport.ts", "utf8"), /modelToolCapabilityParity\.json/);
assert.match(readFileSync("backend/testModelToolProviderTransport.py", "utf8"), /modelToolCapabilityParity\.json/);

const server = readFileSync("backend/server.ts", "utf8");
assert.match(server, /findObsoleteModelToolEnvironmentNames/);
assert.match(server, /app\.get\("\/ready"[\s\S]*res\.json\(\{ status: "ready" \}\)/);
const gateway = readFileSync("backend/llm_service.py", "utf8");
assert.match(gateway, /"google_genai_sdk_available"/);
assert.match(gateway, /"canonical_flags"/);
assert.doesNotMatch(gateway, /google\.generativeai|genai\.configure\(|genai\.embed_content\(/);
assert.match(gateway, /client\.models\.embed_content/);

const migration = readFileSync("supabase/migrations/20260715120000_automatic_memory_idempotency.sql", "utf8");
assert.match(migration, /get_automatic_memory_idempotency_schema_version/i);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(packageJson.scripts["verify:model-native-tools"], "node scripts/verifyModelNativeTools.mjs");
const releaseHarness = readFileSync("scripts/verifyModelNativeTools.mjs", "utf8");
assert.match(releaseHarness, /backend\/verifyModelNativeToolsLive\.py/);
assert.match(releaseHarness, /verify:model-native-executors-live/);
assert.match(releaseHarness, /verify:model-native-memory-migration-live/);
assert.match(releaseHarness, /verify:model-native-stack-startup-live/);
const liveProviderHarness = readFileSync("backend/verifyModelNativeToolsLive.py", "utf8");
assert.match(liveProviderHarness, /status in \{408, 409, 429\} or status >= 500/);
assert.match(liveProviderHarness, /retried_provider = \{"groq": False, "gemini": False\}/);
const liveExecutorHarness = readFileSync("backend/verifyModelNativeExecutors.ts", "utf8");
assert.match(liveExecutorHarness, /SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED = "false"/);
const migrationVerifier = readFileSync("backend/verifyAutomaticMemoryMigrationLive.ts", "utf8");
assert.match(migrationVerifier, /verifyAutomaticMemoryIdempotencyMigration/);
assert.doesNotMatch(migrationVerifier, /\.sql\(|\.insert\(|\.update\(|\.delete\(/);
const stackStartupVerifier = readFileSync("scripts/verifyModelNativeStackStartupLive.mjs", "utf8");
assert.match(stackStartupVerifier, /model_tool_runtime/);
assert.match(stackStartupVerifier, /JSON\.stringify\(\{ status: "ready" \}\)/);
assert.match(stackStartupVerifier, /children\.reverse\(\)\.map\(stop\)/);

console.log("Model-tool configuration and readiness checks passed.");
