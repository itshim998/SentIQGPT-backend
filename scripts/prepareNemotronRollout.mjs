import { pathToFileURL } from "node:url";
import {
  FULL_ROLLOUT_PLAIN_ENV,
  FULL_ROLLOUT_SECRET_ENV_NAMES,
} from "./renderNemotronFullRolloutUpdate.mjs";

const SAFE_REVISION_SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const ROLLOUT_REVISION_SECRET_ENV_NAMES = Object.freeze([
  ...FULL_ROLLOUT_SECRET_ENV_NAMES,
  "SUPABASE_URL_1",
]);

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

export function buildNemotronRolloutRevisionPlan({
  fromRevision,
  image,
  revisionSuffix,
  containerName,
  deploymentRevision,
  secretReferences,
}) {
  const source = required(fromRevision, "fromRevision");
  const deployImage = required(image, "image");
  const suffix = required(revisionSuffix, "revisionSuffix");
  const container = required(containerName, "containerName");
  const deployment = required(deploymentRevision, "deploymentRevision");
  if (!SAFE_REVISION_SUFFIX.test(suffix)) throw new Error("revisionSuffix is invalid.");
  if (!deployImage.includes(":")) throw new Error("image must use an immutable tag.");

  const setEnvironment = [];
  for (const name of ROLLOUT_REVISION_SECRET_ENV_NAMES) {
    const secretRef = required(secretReferences?.[name], `secretReferences.${name}`);
    setEnvironment.push(Object.freeze({ name, kind: "secret-reference", secretRef }));
  }
  for (const [name, value] of Object.entries(FULL_ROLLOUT_PLAIN_ENV)) {
    setEnvironment.push(Object.freeze({ name, kind: "plain", value }));
  }
  setEnvironment.push(Object.freeze({
    name: "SENTIQ_DEPLOYMENT_REVISION",
    kind: "plain",
    value: deployment,
  }));

  return Object.freeze({
    fromRevision: source,
    image: deployImage,
    revisionSuffix: suffix,
    containerName: container,
    deploymentRevision: deployment,
    setEnvironment: Object.freeze(setEnvironment),
  });
}

export function buildRevisionCopyArguments(plan) {
  const environmentArguments = plan.setEnvironment.map((entry) => (
    entry.kind === "secret-reference"
      ? `${entry.name}=secretref:${entry.secretRef}`
      : `${entry.name}=${entry.value}`
  ));
  return Object.freeze([
    "--from-revision", plan.fromRevision,
    "--container-name", plan.containerName,
    "--image", plan.image,
    "--revision-suffix", plan.revisionSuffix,
    "--set-env-vars", ...environmentArguments,
  ]);
}

export function simulateRevisionCopyEnvironment(sourceEnvironment, plan) {
  const environment = structuredClone(Array.isArray(sourceEnvironment) ? sourceEnvironment : []);
  for (const planned of plan.setEnvironment) {
    const existing = environment.find((entry) => entry?.name === planned.name);
    const replacement = planned.kind === "secret-reference"
      ? { name: planned.name, secretRef: planned.secretRef }
      : { name: planned.name, value: planned.value };
    if (existing) Object.assign(existing, replacement);
    else environment.push(replacement);
    if (existing) {
      if (planned.kind === "secret-reference") delete existing.value;
      else delete existing.secretRef;
    }
  }
  return environment;
}

export function buildExactRollbackPlan({
  rollbackSourceRevision,
  rollbackRevision,
  failedRevision,
}) {
  const source = required(rollbackSourceRevision, "rollbackSourceRevision");
  const rollback = required(rollbackRevision, "rollbackRevision");
  const failed = required(failedRevision, "failedRevision");
  if (source === rollback) throw new Error("Rollback source and copy revisions must differ.");
  if (source === failed) throw new Error("Rollback source and failed revisions must differ.");
  if (rollback === failed) throw new Error("Rollback and failed revisions must differ.");
  return Object.freeze({
    copyFromRevision: source,
    rollbackRevision: rollback,
    failedRevision: failed,
    createExactRevisionCopy: true,
    revisionMode: "multiple",
    revisionWeights: Object.freeze({
      [source]: 0,
      [rollback]: 100,
      [failed]: 0,
    }),
    deactivateFailedRevision: true,
    reconstructEnvironment: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error("prepareNemotronRollout.mjs is a library; use the tested workflow argument builder.");
  process.exitCode = 2;
}
