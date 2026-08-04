import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { renderAzureContainerAppUpdate } from "./renderAzureContainerAppUpdate.mjs";

export const FULL_ROLLOUT_PLAIN_ENV = Object.freeze({
  SENTIQ_NEMOTRON_ROLLOUT_STAGE: "full",
  SENTIQ_NEMOTRON_FULL_ROLLOUT_ACK: "ENABLE_FULL_NEMOTRON_ROLLOUT",
  SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID: "",
  SENTIQ_NVIDIA_PROVIDER_ENABLED: "true",
  SENTIQ_NEMOTRON_INTUITIVE_ENABLED: "true",
  SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED: "true",
  SENTIQ_INTUITIVE_QUOTA_UI_ENABLED: "true",
  SENTIQ_FAST_PARALLEL_INPUT_SAFETY_ENABLED: "true",
  SENTIQ_FAST_SPECULATIVE_BUFFER_ITEMS: "512",
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
  NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
  NVIDIA_NEMOTRON_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
  POLLINATIONS_OPENAI_ENDPOINT: "https://gen.pollinations.ai/v1/chat/completions",
  POLLINATIONS_INTUITIVE_MODEL: "deepseek",
  SENTIQ_NVIDIA_MAX_GENERATED_TOKENS: "8000",
  SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS: "120000",
  SENTIQ_NVIDIA_FIRST_CHUNK_TIMEOUT_MS: "30000",
  SENTIQ_NVIDIA_STREAM_IDLE_TIMEOUT_MS: "45000",
  SENTIQ_NVIDIA_KEY_COOLDOWN_MS: "60000",
  SENTIQ_NVIDIA_429_COOLDOWN_MS: "180000",
  SENTIQ_NVIDIA_AUTH_FAILURE_COOLDOWN_MS: "3600000",
  SENTIQ_PYTHON_LLM_QUOTA_ENFORCEMENT: "false",
});

export const FULL_ROLLOUT_SECRET_ENV_NAMES = Object.freeze([
  "NVIDIA_API_KEY_1",
  "NVIDIA_API_KEY_2",
  "NVIDIA_API_KEY_3",
  "NVIDIA_API_KEY_4",
  "NVIDIA_API_KEY_5",
  "NVIDIA_API_KEY_6",
  "POLLINATIONS_API_KEY",
  "SENTIQ_ANON_USAGE_HASH_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY_1",
]);

function upsertPlain(environment, name, value) {
  const existing = environment.find((entry) => entry?.name === name);
  if (existing) {
    existing.value = String(value);
    delete existing.secretRef;
    return;
  }
  environment.push({ name, value: String(value) });
}

function upsertSecretReference(environment, name, secretRef) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,251}[a-z0-9])?$/.test(secretRef)) {
    throw new Error(`Invalid Azure secret reference for ${name}.`);
  }
  const existing = environment.find((entry) => entry?.name === name);
  if (existing) {
    existing.secretRef = secretRef;
    delete existing.value;
    return;
  }
  environment.push({ name, secretRef });
}

function removeDuplicateEnvironmentEntries(environment) {
  const seen = new Set();
  for (let index = 0; index < environment.length;) {
    const name = environment[index]?.name;
    if (!name || !seen.has(name)) {
      if (name) seen.add(name);
      index += 1;
      continue;
    }
    environment.splice(index, 1);
  }
}

export function renderNemotronFullRolloutUpdate(args) {
  const document = renderAzureContainerAppUpdate({
    document: structuredClone(args.document),
    containerName: args.containerName,
    image: args.image,
    revisionSuffix: args.revisionSuffix,
    minReplicas: args.minReplicas,
    maxReplicas: args.maxReplicas,
    cooldownSeconds: args.cooldownSeconds,
    readinessPath: "/ready",
  });
  const container = document.properties.template.containers
    .find((candidate) => candidate?.name === args.containerName);
  if (!container) throw new Error("Target container was not found after base rendering.");
  container.env = Array.isArray(container.env) ? container.env : [];

  const secretRefs = args.secretRefs && typeof args.secretRefs === "object"
    ? args.secretRefs
    : {};
  for (const name of FULL_ROLLOUT_SECRET_ENV_NAMES) {
    const secretRef = String(secretRefs[name] ?? "").trim();
    if (!secretRef) throw new Error(`Missing required Azure secret reference for ${name}.`);
    upsertSecretReference(container.env, name, secretRef);
  }

  for (const [name, value] of Object.entries(FULL_ROLLOUT_PLAIN_ENV)) {
    upsertPlain(container.env, name, value);
  }
  upsertPlain(container.env, "SENTIQ_DEPLOYMENT_REVISION", args.deploymentRevision);
  removeDuplicateEnvironmentEntries(container.env);
  return document;
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
  if (!args.input || !args.output || !args["secret-refs"] || !args["deployment-revision"]) {
    throw new Error("--input, --output, --secret-refs, and --deployment-revision are required.");
  }
  const document = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const secretRefs = JSON.parse(fs.readFileSync(args["secret-refs"], "utf8"));
  const rendered = renderNemotronFullRolloutUpdate({
    document,
    secretRefs,
    containerName: args["container-name"],
    image: args.image,
    revisionSuffix: args["revision-suffix"],
    minReplicas: args["min-replicas"],
    maxReplicas: args["max-replicas"],
    cooldownSeconds: args["cooldown-seconds"],
    deploymentRevision: args["deployment-revision"],
  });
  fs.writeFileSync(args.output, `${JSON.stringify(rendered, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`Nemotron full rollout renderer failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
