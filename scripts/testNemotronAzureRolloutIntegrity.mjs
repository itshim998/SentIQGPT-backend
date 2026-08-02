import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  FULL_ROLLOUT_PLAIN_ENV,
} from "./renderNemotronFullRolloutUpdate.mjs";
import {
  assertNoManagementPlaneRedactedEnvironmentEntries,
  renderAzureContainerAppUpdate,
} from "./renderAzureContainerAppUpdate.mjs";
import {
  classifyAzureEnvironmentEntry,
  resolveAzureSecretReferences,
} from "./resolveAzureSecretReferences.mjs";
import {
  buildAzureRuntimeProbeCommand,
  LEGACY_ROLLBACK_ALLOWED_MISSING_CHECKS,
  verifyAzureRuntimeEnvironment,
} from "./verifyAzureRuntimeEnvironment.mjs";
import {
  inspectAzureContainerAppState,
} from "./inspectAzureContainerAppState.mjs";
import {
  buildExactRollbackPlan,
  buildNemotronRolloutRevisionPlan,
  buildRevisionCopyArguments,
  simulateRevisionCopyEnvironment,
} from "./prepareNemotronRollout.mjs";

const containerName = "sentiqgpt-backend";
const rollbackRevisionName = "sentiqgpt-backend--ready";
const unsafeLatestRevisionName = "sentiqgpt-backend--unready";
const existingEnvironment = [
  { name: "SUPABASE_URL_1", value: "", secretRef: "supabase-url-1" },
  { name: "SUPABASE_SERVICE_ROLE_KEY_1", secretRef: "supabase-service-role-key-1" },
  { name: "SUPABASE_ANON_KEY_1", secretRef: "supabase-anon-key-1" },
  { name: "POLLINATIONS_API_KEY", secretRef: "pollinations-api-key" },
  { name: "SENTIQ_INTERNAL_SERVICE_TOKEN", secretRef: "sentiq-internal-service-token" },
  { name: "UNRELATED_SECRET", secretRef: "unrelated-secret" },
  { name: "UNRELATED_PLAIN", value: "preserved" },
  { name: "SENTIQ_NVIDIA_PROVIDER_ENABLED", value: "false" },
  { name: "SENTIQ_NEMOTRON_INTUITIVE_ENABLED", value: "false" },
  { name: "SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED", value: "false" },
  { name: "SENTIQ_INTUITIVE_QUOTA_UI_ENABLED", value: "false" },
];
const existingSecretNames = [
  "supabase-url-1",
  "supabase-service-role-key-1",
  "supabase-anon-key-1",
  "pollinations-api-key",
  "sentiq-internal-service-token",
  "unrelated-secret",
];
const githubSecretsPresent = Object.fromEntries([
  "NVIDIA_API_KEY_1",
  "NVIDIA_API_KEY_2",
  "NVIDIA_API_KEY_3",
  "NVIDIA_API_KEY_4",
  "NVIDIA_API_KEY_5",
  "NVIDIA_API_KEY_6",
  "SENTIQ_ANON_USAGE_HASH_SECRET",
].map((name) => [name, true]));

// A/B: both Azure secret shapes resolve through secretRef even when value is
// explicitly empty or omitted.
assert.deepEqual(
  classifyAzureEnvironmentEntry({ name: "A", value: "", secretRef: "secret-a" }),
  { kind: "secret-reference", secretRef: "secret-a" },
);
assert.deepEqual(
  classifyAzureEnvironmentEntry({ name: "B", secretRef: "secret-b" }),
  { kind: "secret-reference", secretRef: "secret-b" },
);

const resolution = resolveAzureSecretReferences({
  environment: existingEnvironment,
  azureSecretNames: existingSecretNames,
  githubSecretsPresent,
});
assert.equal(resolution.ok, true);
assert.equal(resolution.references.SUPABASE_URL_1, "supabase-url-1");

// C/D: missing and unresolved required references fail closed.
const missingReference = resolveAzureSecretReferences({
  environment: existingEnvironment.filter((entry) => entry.name !== "SENTIQ_INTERNAL_SERVICE_TOKEN"),
  azureSecretNames: existingSecretNames,
  githubSecretsPresent,
});
assert(missingReference.errors.some((error) => (
  error.code === "missing_secret_reference"
  && error.environmentName === "SENTIQ_INTERNAL_SERVICE_TOKEN"
)));
const unresolvedReference = resolveAzureSecretReferences({
  environment: existingEnvironment.map((entry) => (
    entry.name === "SENTIQ_INTERNAL_SERVICE_TOKEN"
      ? { name: entry.name, secretRef: "not-in-azure" }
      : entry
  )),
  azureSecretNames: existingSecretNames,
  githubSecretsPresent,
});
assert(unresolvedReference.errors.some((error) => (
  error.code === "unresolved_secret_reference"
  && error.environmentName === "SENTIQ_INTERNAL_SERVICE_TOKEN"
)));

// E/F: management-plane name-only entries are classified as redacted, while
// the runtime verifier proves critical values without returning any value.
assert.deepEqual(
  classifyAzureEnvironmentEntry({ name: "PLAIN_REDACTED" }),
  { kind: "management-plane-redacted" },
);
const runtimeEnvironment = {
  SUPABASE_URL_1: "https://example.invalid",
  SUPABASE_SERVICE_ROLE_KEY_1: "synthetic-credential-value",
  SUPABASE_ANON_KEY_1: "synthetic-anon-value",
  SENTIQ_INTERNAL_SERVICE_TOKEN: "synthetic-token-value",
  SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS: "false",
  SENTIQ_MODEL_TOOL_REGISTRY_ENABLED: "true",
  SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_IMAGE_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_CHART_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_FILE_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_MEMORY_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED: "false",
};
const runtimeReport = verifyAzureRuntimeEnvironment(runtimeEnvironment);
assert.equal(runtimeReport.ok, true);
assert(!JSON.stringify(runtimeReport).includes("synthetic-credential-value"));
const runtimeProbeCommand = buildAzureRuntimeProbeCommand();
assert(runtimeProbeCommand.length < 2_000);
const runtimeProbeExecution = spawnSync(
  "python",
  ["-c", runtimeProbeCommand.slice("python -c ".length)],
  { encoding: "utf8", env: { ...process.env, ...runtimeEnvironment } },
);
assert.equal(runtimeProbeExecution.status, 0, runtimeProbeExecution.stderr);
const encodedRuntimeReport = JSON.parse(runtimeProbeExecution.stdout);
assert.equal(encodedRuntimeReport.ok, true);
assert(!runtimeProbeExecution.stdout.includes("synthetic-credential-value"));

// Legacy rollback compatibility is narrow and explicit. Strict verification
// still rejects the missing Pollinations transport flag.
const legacyRuntimeEnvironment = { ...runtimeEnvironment };
delete legacyRuntimeEnvironment.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED;

const strictLegacyRuntimeReport = verifyAzureRuntimeEnvironment(
  legacyRuntimeEnvironment,
);
assert.equal(strictLegacyRuntimeReport.ok, false);
assert.deepEqual(
  strictLegacyRuntimeReport.failedChecks,
  ["SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED_PRESENT"],
);
assert.deepEqual(strictLegacyRuntimeReport.compatibilityExceptions, []);

// The rollback-source preflight may allow only the newly introduced
// Pollinations transport check to be absent.
const compatibleLegacyRuntimeReport = verifyAzureRuntimeEnvironment(
  legacyRuntimeEnvironment,
  {
    allowedMissingChecks: LEGACY_ROLLBACK_ALLOWED_MISSING_CHECKS,
  },
);
assert.equal(compatibleLegacyRuntimeReport.ok, true);
assert.deepEqual(compatibleLegacyRuntimeReport.failedChecks, []);
assert.deepEqual(
  compatibleLegacyRuntimeReport.compatibilityExceptions,
  ["SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED_PRESENT"],
);

// A different missing requirement still fails closed.
const invalidLegacyRuntimeEnvironment = { ...legacyRuntimeEnvironment };
delete invalidLegacyRuntimeEnvironment.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED;

const invalidLegacyRuntimeReport = verifyAzureRuntimeEnvironment(
  invalidLegacyRuntimeEnvironment,
  {
    allowedMissingChecks: LEGACY_ROLLBACK_ALLOWED_MISSING_CHECKS,
  },
);
assert.equal(invalidLegacyRuntimeReport.ok, false);
assert(
  invalidLegacyRuntimeReport.failedChecks.includes(
    "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED_PRESENT",
  ),
);

// The actual Python command used inside Azure follows the same compatibility
// policy and reports the exception without exposing any values.
const legacyRuntimeProbeCommand = buildAzureRuntimeProbeCommand({
  allowedMissingChecks: LEGACY_ROLLBACK_ALLOWED_MISSING_CHECKS,
});
const legacyRuntimeProbeExecution = spawnSync(
  "python",
  ["-c", legacyRuntimeProbeCommand.slice("python -c ".length)],
  {
    encoding: "utf8",
    env: { ...process.env, ...legacyRuntimeEnvironment },
  },
);
assert.equal(
  legacyRuntimeProbeExecution.status,
  0,
  legacyRuntimeProbeExecution.stderr,
);
const encodedLegacyRuntimeReport = JSON.parse(
  legacyRuntimeProbeExecution.stdout,
);
assert.equal(encodedLegacyRuntimeReport.ok, true);
assert.deepEqual(encodedLegacyRuntimeReport.failedChecks, []);
assert.deepEqual(
  encodedLegacyRuntimeReport.compatibilityExceptions,
  ["SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED_PRESENT"],
);

// Arbitrary compatibility exceptions are rejected.
assert.throws(
  () => verifyAzureRuntimeEnvironment(runtimeEnvironment, {
    allowedMissingChecks: ["DATABASE_CONFIGURATION_AVAILABLE"],
  }),
  /Unsupported runtime compatibility exception/,
);

function revisionFixture({
  name = rollbackRevisionName,
  healthState = "Healthy",
  runningState = "Running",
  active = true,
} = {}) {
  return {
    name,
    properties: {
      active,
      provisioningState: "Provisioned",
      healthState,
      runningState,
      trafficWeight: active ? 100 : 0,
      template: {
        containers: [{
          name: containerName,
          image: "registry.example/sentiqgpt-backend:immutable-ready-sha",
          env: structuredClone(existingEnvironment),
          probes: [{ type: "Readiness", httpGet: { path: "/ready", port: 3001 } }],
        }],
      },
    },
  };
}

const appFixture = {
  properties: {
    latestRevisionName: unsafeLatestRevisionName,
    latestReadyRevisionName: rollbackRevisionName,
    configuration: {
      activeRevisionsMode: "Single",
      ingress: { targetPort: 3001, fqdn: "production.example.invalid" },
    },
  },
};

// G/I/T: latest may differ from last-ready; the healthy last-ready image is
// selected and retained as the rollback source.
const inspection = inspectAzureContainerAppState({
  app: appFixture,
  rollbackRevision: revisionFixture(),
  replicas: [{ name: "ready-replica" }],
  secretResolution: resolution,
  runtimeReport,
  readyHttpStatus: 200,
  containerName,
});
assert.equal(inspection.ok, true);
assert.equal(inspection.latestDiffersFromReady, true);
assert.equal(inspection.rollbackSource.revisionName, rollbackRevisionName);
assert.match(inspection.rollbackSource.image, /immutable-ready-sha$/);

// H: an unhealthy latest revision can never become the rollback source.
const unsafeInspection = inspectAzureContainerAppState({
  app: appFixture,
  rollbackRevision: revisionFixture({
    name: unsafeLatestRevisionName,
    healthState: "Unhealthy",
    runningState: "Degraded",
    active: false,
  }),
  replicas: [],
  secretResolution: resolution,
  runtimeReport,
  readyHttpStatus: 503,
  containerName,
});
assert.equal(unsafeInspection.ok, false);
assert(unsafeInspection.errors.some((error) => error.code === "rollback_source_is_not_latest_ready"));

// J: a renderer can never submit a destructive management-plane {name}-only
// environment entry.
const redactedDocument = {
  properties: {
    template: {
      containers: [{
        name: containerName,
        image: "registry.example/old:sha",
        env: [{ name: "REDACTED_ONLY" }],
      }],
      scale: {},
    },
  },
};
assert.throws(
  () => assertNoManagementPlaneRedactedEnvironmentEntries(redactedDocument),
  /management-plane-redacted/,
);
assert.throws(() => renderAzureContainerAppUpdate({
  document: structuredClone(redactedDocument),
  containerName,
  image: "registry.example/new:sha",
  revisionSuffix: "new-sha",
  minReplicas: "0",
  maxReplicas: "1",
  cooldownSeconds: "900",
  readinessPath: "/ready",
}), /management-plane-redacted/);

const rolloutPlan = buildNemotronRolloutRevisionPlan({
  fromRevision: rollbackRevisionName,
  image: "registry.example/sentiqgpt-backend:immutable-new-sha",
  revisionSuffix: "full-immutable-new-30350000000",
  containerName,
  deploymentRevision: "immutable-new-sha",
  secretReferences: resolution.references,
});
const argumentsList = buildRevisionCopyArguments(rolloutPlan);
const copiedEnvironment = simulateRevisionCopyEnvironment(existingEnvironment, rolloutPlan);

// K/L: revision-copy overrides preserve unrelated plain values and secret refs.
assert.equal(
  copiedEnvironment.find((entry) => entry.name === "UNRELATED_PLAIN").value,
  "preserved",
);
assert.equal(
  copiedEnvironment.find((entry) => entry.name === "UNRELATED_SECRET").secretRef,
  "unrelated-secret",
);
assert(!argumentsList.includes("--replace-env-vars"));
assert(!argumentsList.includes("--yaml"));

// M/N: six NVIDIA slots are added; Pollinations and Supabase reuse Azure
// references and never require duplicate GitHub credentials.
assert.equal(
  rolloutPlan.setEnvironment.filter((entry) => /^NVIDIA_API_KEY_[1-6]$/.test(entry.name)).length,
  6,
);
assert.equal(resolution.create.filter((entry) => /^NVIDIA_API_KEY_[1-6]$/.test(entry.environmentName)).length, 6);
assert.equal(resolution.create.some((entry) => entry.environmentName === "POLLINATIONS_API_KEY"), false);
assert.equal(resolution.create.some((entry) => entry.environmentName === "SUPABASE_URL_1"), false);
assert.equal(resolution.create.some((entry) => entry.environmentName === "SUPABASE_SERVICE_ROLE_KEY_1"), false);

// O: provider, quota, and image-tool flags become true in the controlled rollout.
for (const name of [
  "SENTIQ_NVIDIA_PROVIDER_ENABLED",
  "SENTIQ_NEMOTRON_INTUITIVE_ENABLED",
  "SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED",
  "SENTIQ_INTUITIVE_QUOTA_UI_ENABLED",
  "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
]) {
  assert.equal(FULL_ROLLOUT_PLAIN_ENV[name], "true");
  assert.equal(copiedEnvironment.find((entry) => entry.name === name).value, "true");
}
for (const name of [
  "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
]) {
  assert.equal(FULL_ROLLOUT_PLAIN_ENV[name], "false");
  assert.equal(copiedEnvironment.find((entry) => entry.name === name).value, "false");
}

// The executable workflow must apply the compatibility exception only to the
// old rollback source and must explicitly configure the new revision.
const rolloutWorkflow = fs.readFileSync(
  new URL("../.github/workflows/nemotron-full-rollout.yml", import.meta.url),
  "utf8",
);

assert.equal(
  (
    rolloutWorkflow.match(
      /--allow-missing=SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED_PRESENT/g,
    ) ?? []
  ).length,
  1,
);

assert.equal(
  (
    rolloutWorkflow.match(
      /verifyAzureRuntimeEnvironment\.mjs --emit-command/g,
    ) ?? []
  ).length,
  2,
);

for (const [name, value] of Object.entries({
  SENTIQ_MODEL_TOOL_REGISTRY_ENABLED: "true",
  SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_MODEL_IMAGE_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED: "false",
  SENTIQ_MODEL_CHART_SELECTION_ENABLED: "false",
  SENTIQ_MODEL_FILE_SELECTION_ENABLED: "false",
  SENTIQ_MODEL_MEMORY_SELECTION_ENABLED: "false",
  SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED: "false",
})) {
  assert(
    rolloutWorkflow.includes(`"${name}=${value}"`),
    `${name}=${value} is missing from the executable rollout environment`,
  );
}

assert(
  rolloutWorkflow.includes(
    "Verify the image-only model-tool activation bundle before live probes.",
  ),
);

// P: rollback restores the exact prior revision; it never reconstructs flags
// from redacted metadata.
const rollbackPlan = buildExactRollbackPlan({
  rollbackSourceRevision: rollbackRevisionName,
  rollbackRevision: "sentiqgpt-backend--rollback-copy",
  failedRevision: "sentiqgpt-backend--failed",
});
assert.equal(rollbackPlan.reconstructEnvironment, false);
assert.equal(rollbackPlan.copyFromRevision, rollbackRevisionName);
assert.equal(rollbackPlan.createExactRevisionCopy, true);
assert.equal(rollbackPlan.revisionMode, "multiple");
assert.equal(rollbackPlan.revisionWeights[rollbackRevisionName], 0);
assert.equal(rollbackPlan.revisionWeights["sentiqgpt-backend--rollback-copy"], 100);
assert.equal(
  existingEnvironment.find((entry) => entry.name === "SENTIQ_NVIDIA_PROVIDER_ENABLED").value,
  "false",
);

// Q/R/S: evidence is redacted and always present; both deployment workflows
// serialize production, and ordinary deploys refuse to overwrite blue/green.
assert(!JSON.stringify(resolution).includes("synthetic-credential-value"));
const fullWorkflow = fs.readFileSync(".github/workflows/nemotron-full-rollout.yml", "utf8");
const ordinaryWorkflow = fs.readFileSync(".github/workflows/azure-container-apps.yml", "utf8");
assert.match(fullWorkflow, /nemotron-rollout-summary\.json/);
assert.match(fullWorkflow, /if-no-files-found: error/);
assert.match(fullWorkflow, /group: azure-container-apps-production/);
assert.match(ordinaryWorkflow, /group: azure-container-apps-production/);
assert.match(ordinaryWorkflow, /activeRevisionsMode/);
assert.match(ordinaryWorkflow, /multiple[\s\S]*skip/i);
assert.doesNotMatch(fullWorkflow, /renderNemotronFullRolloutUpdate\.mjs/);
assert.doesNotMatch(fullWorkflow, /az containerapp update[\s\S]*--yaml/);
assert.doesNotMatch(fullWorkflow, /^\s*(?:timeout \d+s )?az containerapp exec/m);
assert.match(
  fullWorkflow,
  /SENTIQ_LIVE_VERIFY_CANARY_LABEL="full-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"[\s\S]{0,300}node scripts\/verifyNemotronFullRolloutLive\.mjs/,
  "full-rollout live verification must provide a valid non-secret canary label",
);
assert.match(fullWorkflow, /rollback_suffix="rollback-\$\{GITHUB_SHA::10\}-\$\{GITHUB_RUN_ID\}"/);
assert.match(
  fullWorkflow,
  /--from-revision "\$\{PREVIOUS_REVISION\}"[\s\S]*--revision-suffix "\$\{rollback_suffix\}"/,
);
assert.match(fullWorkflow, /ready_revision}" == "\$\{rollback_revision\}"/);
assert.doesNotMatch(fullWorkflow, /--mode single/);
assert.equal(
  fullWorkflow.match(/(?:timeout \d+s )?bash scripts\/execAzureContainerAppCommand\.sh/g)?.length,
  5,
  "all five full-rollout exec calls must use a CI-safe pseudo-terminal",
);

console.log("PASS | Nemotron Azure rollout integrity fixtures A-T.");
