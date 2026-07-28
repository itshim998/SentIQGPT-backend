import assert from "node:assert/strict";
import {
  FULL_ROLLOUT_PLAIN_ENV,
  FULL_ROLLOUT_SECRET_ENV_NAMES,
  renderNemotronFullRolloutUpdate,
} from "./renderNemotronFullRolloutUpdate.mjs";

function baseDocument() {
  return {
    properties: {
      configuration: {
        ingress: { targetPort: 3001 },
      },
      template: {
        containers: [{
          name: "sentiqgpt-backend",
          image: "registry.example/old:sha",
          env: [
            { name: "EXISTING_SETTING", value: "preserved" },
            { name: "SENTIQ_NVIDIA_PROVIDER_ENABLED", value: "false" },
          ],
        }],
        scale: { minReplicas: 0, maxReplicas: 1, cooldownPeriod: 900 },
      },
    },
  };
}

const secretRefs = Object.fromEntries(
  FULL_ROLLOUT_SECRET_ENV_NAMES.map((name, index) => [name, `secret-${index + 1}`]),
);
const rendered = renderNemotronFullRolloutUpdate({
  document: baseDocument(),
  secretRefs,
  containerName: "sentiqgpt-backend",
  image: "registry.example/new:sha",
  revisionSuffix: "full-abcdef123456",
  minReplicas: "0",
  maxReplicas: "1",
  cooldownSeconds: "900",
  deploymentRevision: "abcdef1234567890",
});

const container = rendered.properties.template.containers[0];
assert.equal(container.image, "registry.example/new:sha");
assert.equal(rendered.properties.template.revisionSuffix, "full-abcdef123456");
assert.equal(container.probes.find((probe) => probe.type === "Readiness").httpGet.path, "/ready");
assert.equal(container.env.find((entry) => entry.name === "EXISTING_SETTING").value, "preserved");
assert.equal(container.env.find((entry) => entry.name === "SENTIQ_DEPLOYMENT_REVISION").value, "abcdef1234567890");

for (const [name, expected] of Object.entries(FULL_ROLLOUT_PLAIN_ENV)) {
  const entry = container.env.find((candidate) => candidate.name === name);
  assert.equal(entry.value, expected, `${name} must be pinned to the full rollout value`);
  assert.equal("secretRef" in entry, false);
}
for (const name of FULL_ROLLOUT_SECRET_ENV_NAMES) {
  const entry = container.env.find((candidate) => candidate.name === name);
  assert.equal(entry.secretRef, secretRefs[name]);
  assert.equal("value" in entry, false);
}

assert.throws(() => renderNemotronFullRolloutUpdate({
  document: baseDocument(),
  secretRefs: { ...secretRefs, NVIDIA_API_KEY_6: "" },
  containerName: "sentiqgpt-backend",
  image: "registry.example/new:sha",
  revisionSuffix: "full-abcdef123456",
  minReplicas: "0",
  maxReplicas: "1",
  cooldownSeconds: "900",
  deploymentRevision: "abcdef1234567890",
}), /NVIDIA_API_KEY_6/);

assert.throws(() => renderNemotronFullRolloutUpdate({
  document: baseDocument(),
  secretRefs: { ...secretRefs, POLLINATIONS_API_KEY: "INVALID_SECRET_NAME" },
  containerName: "sentiqgpt-backend",
  image: "registry.example/new:sha",
  revisionSuffix: "full-abcdef123456",
  minReplicas: "0",
  maxReplicas: "1",
  cooldownSeconds: "900",
  deploymentRevision: "abcdef1234567890",
}), /Invalid Azure secret reference/);

console.log("Nemotron full rollout Azure renderer tests passed.");
