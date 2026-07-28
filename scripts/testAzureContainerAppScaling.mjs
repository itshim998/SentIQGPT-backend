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
assert.equal(
  workflow.match(/az containerapp revision copy/g)?.length,
  2,
  "normal and selected-image deployments must copy an exact last-ready revision",
);
assert.equal(
  workflow.match(/--from-revision "\$\{(?:PREVIOUS_REVISION|previous_revision)\}"/g)?.length,
  2,
  "both deployments must anchor to an explicitly captured last-ready revision",
);
assert.doesNotMatch(workflow, /renderAzureContainerAppUpdate\.mjs/);
assert.doesNotMatch(workflow, /az containerapp update[\s\S]*--yaml/);
assert.match(workflow, /verifyAzureRuntimeEnvironment\.mjs --emit-command/);
assert.match(workflow, /multiple[\s\S]*ordinary deployment will skip/i);
assert.doesNotMatch(workflow, /^\s*az containerapp exec/m);
assert.match(workflow, /bash scripts\/execAzureContainerAppCommand\.sh/);

const execWrapper = fs.readFileSync("scripts/execAzureContainerAppCommand.sh", "utf8");
assert.match(execWrapper, /printf -v azure_exec_command '%q '/);
assert.match(execWrapper, /script --quiet --return --command/);
assert.match(execWrapper, /\/dev\/null/);
assert.doesNotMatch(execWrapper, /\beval\b/);

console.log("PASS | Azure Container App renderer and revision-copy deployment contracts are safe.");
