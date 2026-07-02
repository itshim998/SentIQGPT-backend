import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const SCALE_ENVIRONMENT_VARIABLES = Object.freeze({
  minReplicas: "SENTIQ_CONTAINER_MIN_REPLICAS",
  maxReplicas: "SENTIQ_CONTAINER_MAX_REPLICAS",
  cooldownSeconds: "SENTIQ_CONTAINER_COOLDOWN_SECONDS",
});

function requireInteger(value, name, minimum, maximum) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseScaleSettings(values) {
  const minReplicas = requireInteger(values.minReplicas, SCALE_ENVIRONMENT_VARIABLES.minReplicas, 0, 1_000);
  const maxReplicas = requireInteger(values.maxReplicas, SCALE_ENVIRONMENT_VARIABLES.maxReplicas, 1, 1_000);
  const cooldownSeconds = requireInteger(
    values.cooldownSeconds,
    SCALE_ENVIRONMENT_VARIABLES.cooldownSeconds,
    30,
    2_147_483_647,
  );

  if (minReplicas > maxReplicas) {
    throw new Error("SENTIQ_CONTAINER_MIN_REPLICAS cannot exceed SENTIQ_CONTAINER_MAX_REPLICAS.");
  }
  if (maxReplicas !== 1) {
    throw new Error(
      "SENTIQ_CONTAINER_MAX_REPLICAS must remain 1 while Deep Research tasks are owned by an in-process worker.",
    );
  }

  return { minReplicas, maxReplicas, cooldownSeconds };
}

function upsertPlainEnvironmentVariable(environment, name, value) {
  const matches = environment
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && typeof entry === "object" && entry.name === name);

  if (matches.length === 0) {
    environment.push({ name, value });
    return;
  }

  const [first, ...duplicates] = matches;
  first.entry.value = value;
  delete first.entry.secretRef;
  for (const duplicate of duplicates.reverse()) environment.splice(duplicate.index, 1);
}

export function renderAzureContainerAppUpdate(args) {
  if (!args.document || typeof args.document !== "object" || Array.isArray(args.document)) {
    throw new Error("Azure Container App input must be a JSON object.");
  }
  if (!args.containerName || !args.image || !args.revisionSuffix) {
    throw new Error("Container name, image, and revision suffix are required.");
  }

  const scale = parseScaleSettings(args);
  const template = args.document.properties?.template;
  const containers = template?.containers;
  if (!template || !Array.isArray(containers)) {
    throw new Error("Azure Container App input is missing properties.template.containers.");
  }

  const matchingContainers = containers.filter((container) => container?.name === args.containerName);
  if (matchingContainers.length !== 1) {
    throw new Error(`Expected exactly one container named ${args.containerName}.`);
  }

  const container = matchingContainers[0];
  container.image = args.image;
  container.env = Array.isArray(container.env) ? container.env : [];
  upsertPlainEnvironmentVariable(
    container.env,
    SCALE_ENVIRONMENT_VARIABLES.minReplicas,
    String(scale.minReplicas),
  );
  upsertPlainEnvironmentVariable(
    container.env,
    SCALE_ENVIRONMENT_VARIABLES.maxReplicas,
    String(scale.maxReplicas),
  );
  upsertPlainEnvironmentVariable(
    container.env,
    SCALE_ENVIRONMENT_VARIABLES.cooldownSeconds,
    String(scale.cooldownSeconds),
  );

  template.revisionSuffix = args.revisionSuffix;
  template.scale = template.scale && typeof template.scale === "object" ? template.scale : {};
  template.scale.minReplicas = scale.minReplicas;
  template.scale.maxReplicas = scale.maxReplicas;
  template.scale.cooldownPeriod = scale.cooldownSeconds;

  return args.document;
}

function readArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Renderer arguments must use --name value pairs.");
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function main() {
  const args = readArguments(process.argv.slice(2));
  if (!args.input || !args.output) throw new Error("--input and --output are required.");
  const document = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const rendered = renderAzureContainerAppUpdate({
    document,
    containerName: args["container-name"],
    image: args.image,
    revisionSuffix: args["revision-suffix"],
    minReplicas: args["min-replicas"],
    maxReplicas: args["max-replicas"],
    cooldownSeconds: args["cooldown-seconds"],
  });
  fs.writeFileSync(args.output, `${JSON.stringify(rendered, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`Azure Container App renderer failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
