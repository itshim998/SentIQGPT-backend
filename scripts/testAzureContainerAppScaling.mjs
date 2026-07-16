import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildContainerProbes,
  parseScaleSettings,
  renderAzureContainerAppUpdate,
  SCALE_ENVIRONMENT_VARIABLES,
} from "./renderAzureContainerAppUpdate.mjs";

const sentinelIngress = {
  external: true,
  targetPort: 3001,
  transport: "Auto",
};
const sentinelRules = [{ name: "existing-http", http: { metadata: { concurrentRequests: "10" } } }];
const document = {
  name: "sentiqgpt-backend",
  properties: {
    configuration: {
      ingress: structuredClone(sentinelIngress),
      secrets: [{ name: "existing-secret" }],
    },
    template: {
      revisionSuffix: "old-revision",
      containers: [{
        name: "sentiqgpt-backend",
        image: "registry/old-image:old",
        env: [
          { name: "SENTIQ_INTERNAL_SERVICE_TOKEN", secretRef: "existing-secret" },
          { name: SCALE_ENVIRONMENT_VARIABLES.minReplicas, value: "1" },
          { name: SCALE_ENVIRONMENT_VARIABLES.minReplicas, value: "duplicate" },
        ],
        probes: [{ type: "Liveness", httpGet: { path: "/health", port: 3001 } }],
      }],
      scale: {
        minReplicas: 1,
        maxReplicas: 1,
        cooldownPeriod: 300,
        pollingInterval: 30,
        rules: structuredClone(sentinelRules),
      },
    },
  },
};

const rendered = renderAzureContainerAppUpdate({
  document: structuredClone(document),
  containerName: "sentiqgpt-backend",
  image: "registry/sentiqgpt-backend:new",
  revisionSuffix: "new-revision",
  minReplicas: "0",
  maxReplicas: "1",
  cooldownSeconds: "900",
  readinessPath: "/ready",
});

const template = rendered.properties.template;
const container = template.containers[0];
assert.deepEqual(rendered.properties.configuration.ingress, sentinelIngress);
assert.deepEqual(template.scale.rules, sentinelRules);
assert.equal(template.scale.pollingInterval, 30);
assert.deepEqual(container.probes, buildContainerProbes("/ready"));
const readinessProbe = container.probes.find((probe) => probe.type === "Readiness");
assert.deepEqual(readinessProbe, {
  type: "Readiness",
  httpGet: { path: "/ready", port: 3001, scheme: "HTTP" },
  initialDelaySeconds: 5,
  periodSeconds: 3,
  timeoutSeconds: 2,
  failureThreshold: 2,
  successThreshold: 1,
});
assert.equal(container.image, "registry/sentiqgpt-backend:new");
assert.equal(template.revisionSuffix, "new-revision");
assert.deepEqual(
  [template.scale.minReplicas, template.scale.maxReplicas, template.scale.cooldownPeriod],
  [0, 1, 900],
);
assert.deepEqual(
  container.env.find((entry) => entry.name === "SENTIQ_INTERNAL_SERVICE_TOKEN"),
  { name: "SENTIQ_INTERNAL_SERVICE_TOKEN", secretRef: "existing-secret" },
);
for (const [key, name] of Object.entries(SCALE_ENVIRONMENT_VARIABLES)) {
  const entries = container.env.filter((entry) => entry.name === name);
  assert.equal(entries.length, 1, `${name} must be present exactly once`);
  const expected = key === "minReplicas" ? "0" : key === "maxReplicas" ? "1" : "900";
  assert.deepEqual(entries[0], { name, value: expected });
}

const rollback = renderAzureContainerAppUpdate({
  document: structuredClone(document),
  containerName: "sentiqgpt-backend",
  image: "registry/sentiqgpt-backend:previous",
  revisionSuffix: "rollback-previous",
  minReplicas: "0",
  maxReplicas: "1",
  cooldownSeconds: "900",
  readinessPath: "/health",
});
assert.deepEqual(
  rollback.properties.template.containers[0].probes,
  buildContainerProbes("/health"),
  "previous-image rollback must restore readiness to /health",
);

assert.throws(
  () => parseScaleSettings({ minReplicas: "0", maxReplicas: "2", cooldownSeconds: "900" }),
  /must remain 1/,
);
assert.throws(
  () => parseScaleSettings({ minReplicas: "2", maxReplicas: "1", cooldownSeconds: "900" }),
  /cannot exceed/,
);
assert.throws(
  () => parseScaleSettings({ minReplicas: "0", maxReplicas: "1", cooldownSeconds: "invalid" }),
  /must be an integer/,
);

const workflow = fs.readFileSync(".github/workflows/azure-container-apps.yml", "utf8");
const canonicalModelToolVariables = [
  "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
  "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
];
for (const name of canonicalModelToolVariables) {
  assert.equal(
    workflow.match(new RegExp(`\\b${name}\\b`, "g"))?.length,
    2,
    `${name} must be validated by both normal and rollback deployments`,
  );
}
assert.match(workflow, /SENTIQ_CONTAINER_MIN_REPLICAS: \$\{\{ vars\.SENTIQ_CONTAINER_MIN_REPLICAS \|\| '0' \}\}/);
assert.match(workflow, /SENTIQ_CONTAINER_MAX_REPLICAS: \$\{\{ vars\.SENTIQ_CONTAINER_MAX_REPLICAS \|\| '1' \}\}/);
assert.match(workflow, /SENTIQ_CONTAINER_COOLDOWN_SECONDS: \$\{\{ vars\.SENTIQ_CONTAINER_COOLDOWN_SECONDS \|\| '900' \}\}/);
assert.equal(
  workflow.match(/node scripts\/renderAzureContainerAppUpdate\.mjs/g)?.length,
  2,
  "normal and rollback deployments must use the protected renderer",
);
assert.equal(
  workflow.match(/--yaml "\$\{update_config\}"/g)?.length,
  2,
  "normal and rollback deployments must apply the rendered Container App configuration",
);
assert.equal(workflow.match(/--readiness-path "\/ready"/g)?.length, 1);
assert.equal(workflow.match(/--readiness-path "\/health"/g)?.length, 1);
assert.equal(
  workflow.match(/Azure Container App scale active:/g)?.length,
  2,
  "normal and rollback deployments must verify active scale values",
);

console.log("PASS | Azure Container App scaling renderer preserved protected configuration.");
