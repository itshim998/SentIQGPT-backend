import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ACCEPTED_RUNNING_STATES = new Set(["Running", "Processing", "RunningAtMaxScale"]);

function normalized(value) {
  return typeof value === "string" ? value.trim() : "";
}

function addError(errors, code, detail = undefined) {
  if (errors.some((error) => error.code === code)) return;
  errors.push(Object.freeze(detail ? { code, detail } : { code }));
}

function findContainer(revision, containerName) {
  const containers = revision?.properties?.template?.containers;
  if (!Array.isArray(containers)) return null;
  const matches = containers.filter((container) => container?.name === containerName);
  return matches.length === 1 ? matches[0] : null;
}

function readinessPath(container) {
  const probes = Array.isArray(container?.probes) ? container.probes : [];
  return probes.find((probe) => String(probe?.type).toLowerCase() === "readiness")
    ?.httpGet?.path;
}

export function inspectAzureContainerAppState({
  app,
  rollbackRevision,
  replicas,
  secretResolution,
  runtimeReport,
  readyHttpStatus,
  containerName,
}) {
  const errors = [];
  const latestRevisionName = normalized(app?.properties?.latestRevisionName);
  const latestReadyRevisionName = normalized(app?.properties?.latestReadyRevisionName);
  const rollbackRevisionName = normalized(rollbackRevision?.name);
  const revisionMode = normalized(app?.properties?.configuration?.activeRevisionsMode).toLowerCase();
  const fqdn = normalized(app?.properties?.configuration?.ingress?.fqdn);
  const targetPort = Number(app?.properties?.configuration?.ingress?.targetPort);
  const container = findContainer(rollbackRevision, containerName);
  const image = normalized(container?.image);
  const provisioningState = normalized(rollbackRevision?.properties?.provisioningState);
  const healthState = normalized(rollbackRevision?.properties?.healthState);
  const runningState = normalized(rollbackRevision?.properties?.runningState);
  const active = rollbackRevision?.properties?.active === true;
  const trafficWeight = Number(rollbackRevision?.properties?.trafficWeight);
  const replicaNames = (Array.isArray(replicas) ? replicas : [])
    .map((replica) => normalized(typeof replica === "string" ? replica : replica?.name))
    .filter(Boolean);

  if (!latestReadyRevisionName) addError(errors, "latest_ready_revision_missing");
  if (!rollbackRevisionName || rollbackRevisionName !== latestReadyRevisionName) {
    addError(errors, "rollback_source_is_not_latest_ready");
  }
  if (rollbackRevisionName === latestRevisionName && healthState !== "Healthy") {
    addError(errors, "unready_latest_revision_rejected");
  }
  if (targetPort !== 3001) addError(errors, "unexpected_target_port");
  if (!["single", "multiple"].includes(revisionMode)) addError(errors, "unsupported_revision_mode");
  if (!fqdn) addError(errors, "production_fqdn_missing");
  if (!container) addError(errors, "expected_container_missing");
  if (!image || !image.includes(":")) addError(errors, "rollback_image_invalid");
  if (provisioningState !== "Provisioned") addError(errors, "rollback_revision_not_provisioned");
  if (healthState !== "Healthy") addError(errors, "rollback_revision_not_healthy");
  if (!ACCEPTED_RUNNING_STATES.has(runningState)) addError(errors, "rollback_revision_not_running");
  if (!active) addError(errors, "rollback_revision_not_active");
  if (trafficWeight !== 100) addError(errors, "rollback_revision_not_serving_all_traffic");
  if (replicaNames.length < 1) addError(errors, "rollback_revision_replica_missing");
  if (readinessPath(container) !== "/ready") addError(errors, "rollback_readiness_probe_invalid");
  if (Number(readyHttpStatus) < 200 || Number(readyHttpStatus) >= 300) {
    addError(errors, "rollback_ready_endpoint_failed");
  }
  if (runtimeReport?.ok !== true) {
    addError(errors, "rollback_runtime_environment_invalid", runtimeReport?.failedChecks ?? []);
  }
  if (secretResolution?.ok !== true) {
    addError(errors, "secret_reference_resolution_failed", secretResolution?.errors ?? []);
  }

  return Object.freeze({
    ok: errors.length === 0,
    latestRevisionName,
    latestReadyRevisionName,
    latestDiffersFromReady: Boolean(
      latestRevisionName
      && latestReadyRevisionName
      && latestRevisionName !== latestReadyRevisionName
    ),
    revisionMode,
    fqdn,
    rollbackSource: Object.freeze({
      revisionName: rollbackRevisionName,
      image,
      containerName,
      provisioningState,
      healthState,
      runningState,
      active,
      trafficWeight,
      runningReplicaCount: replicaNames.length,
      readyHttpStatus: Number(readyHttpStatus),
    }),
    errors: Object.freeze(errors),
  });
}

function readArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must use --name value pairs.");
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function main() {
  const args = readArguments(process.argv.slice(2));
  const required = ["app", "revision", "replicas", "secret-resolution", "runtime-report", "output", "container-name"];
  if (required.some((name) => !args[name])) {
    throw new Error(`Required arguments: ${required.map((name) => `--${name}`).join(", ")}.`);
  }
  const result = inspectAzureContainerAppState({
    app: readJson(args.app),
    rollbackRevision: readJson(args.revision),
    replicas: readJson(args.replicas),
    secretResolution: readJson(args["secret-resolution"]),
    runtimeReport: readJson(args["runtime-report"]),
    readyHttpStatus: Number(args["ready-http-status"]),
    containerName: args["container-name"],
  });
  fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    event: "azure_container_app_state",
    ok: result.ok,
    latestRevisionName: result.latestRevisionName,
    latestReadyRevisionName: result.latestReadyRevisionName,
    rollbackSource: result.rollbackSource,
    errors: result.errors,
  }));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({
      event: "azure_container_app_state",
      ok: false,
      errorClass: error instanceof Error ? error.name : "Error",
    }));
    process.exitCode = 1;
  }
}
