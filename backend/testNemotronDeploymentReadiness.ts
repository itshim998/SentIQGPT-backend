import assert from "node:assert/strict";
import {
  EXPECTED_NVIDIA_MODEL,
  EXPECTED_POLLINATIONS_MODEL,
  NEMOTRON_FULL_ROLLOUT_ACK,
  evaluateNemotronDeploymentReadiness,
} from "./nemotronDeploymentReadiness";
import { NEMOTRON_ROLLOUT_ENV } from "./nemotronRolloutFlags";

function enabledEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    SENTIQ_NEMOTRON_ROLLOUT_STAGE: "canary",
    SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID: "canary-revision-001",
    [NEMOTRON_ROLLOUT_ENV.nvidiaProvider]: "true",
    [NEMOTRON_ROLLOUT_ENV.nemotronIntuitive]: "true",
    [NEMOTRON_ROLLOUT_ENV.unifiedTextTokensV2]: "true",
    [NEMOTRON_ROLLOUT_ENV.intuitiveQuotaUi]: "true",
    NVIDIA_API_KEY_1: "secret-provider-key",
    NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
    NVIDIA_NEMOTRON_MODEL: EXPECTED_NVIDIA_MODEL,
    POLLINATIONS_INTUITIVE_MODEL: EXPECTED_POLLINATIONS_MODEL,
    SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS: "120000",
    SENTIQ_NVIDIA_MAX_GENERATED_TOKENS: "8000",
    SENTIQ_ANON_USAGE_HASH_SECRET: "secret-anonymous-hash-salt",
    SUPABASE_URL_1: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY_1: "secret-service-role",
    SENTIQ_PYTHON_LLM_QUOTA_ENFORCEMENT: "false",
    ...overrides,
  };
}

const dormant = evaluateNemotronDeploymentReadiness({});
assert.equal(dormant.ready, true);
assert.equal(dormant.stage, "off");
assert.equal(dormant.activeFlagCount, 0);

const validCanary = evaluateNemotronDeploymentReadiness(enabledEnvironment(), {
  requireEnabled: true,
  requireCompleteBundle: true,
  expectedStage: "canary",
});
assert.equal(validCanary.ready, true);
assert.equal(validCanary.checks.providerKeySlots, 1);
assert.equal(validCanary.checks.flagBundleComplete, true);

const serializedCanary = JSON.stringify(validCanary);
assert.equal(serializedCanary.includes("secret-provider-key"), false);
assert.equal(serializedCanary.includes("secret-service-role"), false);
assert.equal(serializedCanary.includes("secret-anonymous-hash-salt"), false);

// Provider-only canarying is a safe dependency-first stage and must remain
// restartable. The warning prevents mistaking it for the complete rollout.
const providerOnly = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  [NEMOTRON_ROLLOUT_ENV.nemotronIntuitive]: "false",
  [NEMOTRON_ROLLOUT_ENV.unifiedTextTokensV2]: "false",
  [NEMOTRON_ROLLOUT_ENV.intuitiveQuotaUi]: "false",
  SENTIQ_ANON_USAGE_HASH_SECRET: undefined,
  SUPABASE_URL_1: undefined,
  SUPABASE_SERVICE_ROLE_KEY_1: undefined,
}));
assert.equal(providerOnly.ready, true);
assert.ok(providerOnly.warnings.some((warning) => warning.code === "partial_flag_bundle"));
assert.equal(providerOnly.issues.length, 0);

const completeRequired = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  [NEMOTRON_ROLLOUT_ENV.nemotronIntuitive]: "false",
  [NEMOTRON_ROLLOUT_ENV.unifiedTextTokensV2]: "false",
  [NEMOTRON_ROLLOUT_ENV.intuitiveQuotaUi]: "false",
}), { requireCompleteBundle: true });
assert.equal(completeRequired.ready, false);
assert.ok(completeRequired.issues.some((issue) => issue.code === "complete_flag_bundle_required"));

const intuitiveWithoutProvider = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  [NEMOTRON_ROLLOUT_ENV.nvidiaProvider]: "false",
}));
assert.equal(intuitiveWithoutProvider.ready, false);
assert.ok(intuitiveWithoutProvider.issues.some((issue) => issue.code === "intuitive_requires_provider"));

const uiWithoutUnified = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  [NEMOTRON_ROLLOUT_ENV.unifiedTextTokensV2]: "false",
  [NEMOTRON_ROLLOUT_ENV.nemotronIntuitive]: "false",
}));
assert.equal(uiWithoutUnified.ready, false);
assert.ok(uiWithoutUnified.issues.some((issue) => issue.code === "quota_ui_requires_unified_tokens"));

const stageOff = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  SENTIQ_NEMOTRON_ROLLOUT_STAGE: "off",
}));
assert.equal(stageOff.ready, false);
assert.ok(stageOff.issues.some((issue) => issue.code === "flags_enabled_while_stage_off"));

const missingProviderKey = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  NVIDIA_API_KEY_1: undefined,
}));
assert.equal(missingProviderKey.ready, false);
assert.ok(missingProviderKey.issues.some((issue) => issue.code === "provider_key_pool_empty"));

const missingGuestSecret = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  SENTIQ_ANON_USAGE_HASH_SECRET: undefined,
}));
assert.equal(missingGuestSecret.ready, false);
assert.ok(missingGuestSecret.issues.some((issue) => issue.code === "anonymous_identity_secret_missing"));

const wrongFallback = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  POLLINATIONS_INTUITIVE_MODEL: "different-model",
}));
assert.equal(wrongFallback.ready, false);
assert.ok(wrongFallback.issues.some((issue) => issue.code === "fallback_model_not_pinned"));

const excessiveTimeout = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS: "120001",
}));
assert.equal(excessiveTimeout.ready, false);
assert.ok(excessiveTimeout.issues.some((issue) => issue.code === "invalid_intuitive_timeout"));

const legacyQuotaEnabled = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  SENTIQ_PYTHON_LLM_QUOTA_ENFORCEMENT: "true",
}));
assert.equal(legacyQuotaEnabled.ready, false);
assert.ok(legacyQuotaEnabled.issues.some((issue) => issue.code === "legacy_python_quota_enabled"));

const fullWithoutAck = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  SENTIQ_NEMOTRON_ROLLOUT_STAGE: "full",
  SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID: undefined,
}));
assert.equal(fullWithoutAck.ready, false);
assert.ok(fullWithoutAck.issues.some((issue) => issue.code === "full_rollout_not_acknowledged"));

const validFull = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  SENTIQ_NEMOTRON_ROLLOUT_STAGE: "full",
  SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID: undefined,
  SENTIQ_NEMOTRON_FULL_ROLLOUT_ACK: NEMOTRON_FULL_ROLLOUT_ACK,
}), {
  requireEnabled: true,
  requireCompleteBundle: true,
  expectedStage: "full",
});
assert.equal(validFull.ready, true);

// An emergency kill switch may reduce a full rollout to a safe partial subset.
// Startup remains available, while the report makes the degraded bundle visible.
const fullKillSwitch = evaluateNemotronDeploymentReadiness(enabledEnvironment({
  SENTIQ_NEMOTRON_ROLLOUT_STAGE: "full",
  SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID: undefined,
  SENTIQ_NEMOTRON_FULL_ROLLOUT_ACK: NEMOTRON_FULL_ROLLOUT_ACK,
  [NEMOTRON_ROLLOUT_ENV.nemotronIntuitive]: "false",
}));
assert.equal(fullKillSwitch.ready, true);
assert.ok(fullKillSwitch.warnings.some((warning) => warning.code === "partial_flag_bundle"));

console.log("Nemotron deployment readiness checks passed.");
