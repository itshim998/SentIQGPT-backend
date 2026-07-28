import assert from "node:assert/strict";
import {
  UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION,
  verifyUnifiedTextProductionReadiness,
} from "./unifiedTextProductionReadiness";

const environment = {
  SUPABASE_URL_1: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY_1: "service-role-secret",
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function main(): Promise<void> {
  const calls: string[] = [];
  const passingFetch: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/get_unified_text_tokens_v2_full_rollout_schema_version")) {
      return response(UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION);
    }
    if (url.endsWith("/verify_unified_text_tokens_v2_rollout")) {
      return response({
        ready: true,
        schema_version: UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION,
        missing_count: 0,
        missing: [],
      });
    }
    return response({}, 404);
  };

  const passing = await verifyUnifiedTextProductionReadiness(environment, passingFetch);
  assert.equal(passing.ready, true);
  assert.equal(passing.issueCode, null);
  assert.equal(calls.length, 2);

  const staleFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/get_unified_text_tokens_v2_full_rollout_schema_version")) {
      return response("20260727120000");
    }
    return response({
      ready: true,
      schema_version: "20260727120000",
      missing_count: 0,
    });
  };
  const stale = await verifyUnifiedTextProductionReadiness(environment, staleFetch);
  assert.equal(stale.ready, false);
  assert.equal(stale.issueCode, "unified_text_full_rollout_migration_incomplete");

  const missingObjectsFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/get_unified_text_tokens_v2_full_rollout_schema_version")) {
      return response(UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION);
    }
    return response({
      ready: false,
      schema_version: UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION,
      missing_count: 2,
    });
  };
  const missingObjects = await verifyUnifiedTextProductionReadiness(environment, missingObjectsFetch);
  assert.equal(missingObjects.ready, false);
  assert.equal(missingObjects.missingCount, 2);

  const unavailableFetch: typeof fetch = async () => response({ error: "unavailable" }, 404);
  const unavailable = await verifyUnifiedTextProductionReadiness(environment, unavailableFetch);
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.issueCode, "unified_text_full_rollout_migration_unavailable");

  const missingEnvironment = await verifyUnifiedTextProductionReadiness({}, passingFetch);
  assert.equal(missingEnvironment.ready, false);
  assert.equal(missingEnvironment.issueCode, "unified_text_database_environment_missing");

  console.log("Unified text production readiness tests passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
