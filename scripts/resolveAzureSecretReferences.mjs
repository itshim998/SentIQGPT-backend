import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const NVIDIA_SECRET_REQUIREMENTS = Object.freeze(
  Array.from({ length: 6 }, (_, index) => Object.freeze({
    environmentName: `NVIDIA_API_KEY_${index + 1}`,
    fallbackSecretName: `nvidia-key-${index + 1}`,
    githubSecretName: `NVIDIA_API_KEY_${index + 1}`,
  })),
);

export const REQUIRED_EXISTING_SECRET_ENVIRONMENT = Object.freeze([
  "SENTIQ_INTERNAL_SERVICE_TOKEN",
  "POLLINATIONS_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY_1",
]);

export const ROLLOUT_CREATED_SECRET_REQUIREMENTS = Object.freeze([
  ...NVIDIA_SECRET_REQUIREMENTS,
  Object.freeze({
    environmentName: "SENTIQ_ANON_USAGE_HASH_SECRET",
    fallbackSecretName: "anon-usage-secret",
    githubSecretName: "SENTIQ_ANON_USAGE_HASH_SECRET",
  }),
]);

const AZURE_SECRET_NAME = /^[a-z0-9](?:[a-z0-9-]{0,251}[a-z0-9])?$/;

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function normalizedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSecretNames(values) {
  const result = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const name = normalizedString(typeof value === "string" ? value : value?.name);
    if (name) result.add(name);
  }
  return result;
}

function findEnvironmentEntry(environment, name) {
  return (Array.isArray(environment) ? environment : [])
    .find((entry) => entry && typeof entry === "object" && entry.name === name);
}

export function classifyAzureEnvironmentEntry(entry) {
  if (!entry || typeof entry !== "object") return Object.freeze({ kind: "missing" });
  const secretRef = normalizedString(entry.secretRef);
  if (secretRef) return Object.freeze({ kind: "secret-reference", secretRef });
  if (own(entry, "value")) {
    const hasValue = normalizedString(entry.value).length > 0;
    return Object.freeze({ kind: hasValue ? "plain-value" : "explicit-empty", hasValue });
  }
  return Object.freeze({ kind: "management-plane-redacted" });
}

function addError(errors, code, environmentName) {
  if (errors.some((error) => error.code === code && error.environmentName === environmentName)) return;
  errors.push(Object.freeze({ code, environmentName }));
}

function requireExistingReference(args, environmentName, references, reused, errors) {
  const classification = classifyAzureEnvironmentEntry(
    findEnvironmentEntry(args.environment, environmentName),
  );
  if (classification.kind !== "secret-reference") {
    addError(errors, "missing_secret_reference", environmentName);
    return;
  }
  if (!args.secretNames.has(classification.secretRef)) {
    addError(errors, "unresolved_secret_reference", environmentName);
    return;
  }
  references[environmentName] = classification.secretRef;
  reused.push(Object.freeze({ environmentName, secretName: classification.secretRef }));
}

function resolveCanonicalSupabaseUrl(args, references, reused, errors) {
  const environmentName = "SUPABASE_URL_1";
  const classification = classifyAzureEnvironmentEntry(
    findEnvironmentEntry(args.environment, environmentName),
  );
  if (
    classification.kind === "secret-reference"
    && args.secretNames.has(classification.secretRef)
  ) {
    references[environmentName] = classification.secretRef;
    reused.push(Object.freeze({ environmentName, secretName: classification.secretRef }));
    return;
  }
  if (classification.kind === "secret-reference") {
    addError(errors, "unresolved_secret_reference", environmentName);
    return;
  }
  if (!args.secretNames.has("supabase-url-1")) {
    addError(errors, "canonical_supabase_url_secret_missing", environmentName);
    return;
  }
  references[environmentName] = "supabase-url-1";
  reused.push(Object.freeze({
    environmentName,
    secretName: "supabase-url-1",
    restoredCanonicalReference: true,
  }));
}

function resolveCreatedReference(args, requirement, references, reused, create, errors) {
  const classification = classifyAzureEnvironmentEntry(
    findEnvironmentEntry(args.environment, requirement.environmentName),
  );
  if (classification.kind === "secret-reference") {
    if (!args.secretNames.has(classification.secretRef)) {
      addError(errors, "unresolved_secret_reference", requirement.environmentName);
      return;
    }
    references[requirement.environmentName] = classification.secretRef;
    reused.push(Object.freeze({
      environmentName: requirement.environmentName,
      secretName: classification.secretRef,
    }));
    return;
  }

  if (!args.githubSecretsPresent?.[requirement.githubSecretName]) {
    addError(errors, "github_secret_missing", requirement.environmentName);
    return;
  }
  if (!AZURE_SECRET_NAME.test(requirement.fallbackSecretName)) {
    addError(errors, "invalid_fallback_secret_name", requirement.environmentName);
    return;
  }
  references[requirement.environmentName] = requirement.fallbackSecretName;
  create.push(Object.freeze({
    environmentName: requirement.environmentName,
    secretName: requirement.fallbackSecretName,
    githubSecretName: requirement.githubSecretName,
  }));
}

export function resolveAzureSecretReferences({
  environment,
  azureSecretNames,
  githubSecretsPresent = {},
}) {
  const secretNames = normalizeSecretNames(azureSecretNames);
  const args = {
    environment: Array.isArray(environment) ? environment : [],
    secretNames,
    githubSecretsPresent,
  };
  const references = {};
  const reused = [];
  const create = [];
  const errors = [];

  for (const environmentName of REQUIRED_EXISTING_SECRET_ENVIRONMENT) {
    requireExistingReference(args, environmentName, references, reused, errors);
  }
  resolveCanonicalSupabaseUrl(args, references, reused, errors);
  for (const requirement of ROLLOUT_CREATED_SECRET_REQUIREMENTS) {
    resolveCreatedReference(args, requirement, references, reused, create, errors);
  }

  return Object.freeze({
    ok: errors.length === 0,
    references: Object.freeze({ ...references }),
    reused: Object.freeze(reused),
    create: Object.freeze(create),
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
  if (!args.environment || !args["secret-names"] || !args.output) {
    throw new Error("--environment, --secret-names, and --output are required.");
  }
  const githubSecretsPresent = Object.fromEntries(
    String(args["github-secrets-present"] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => [name, true]),
  );
  const result = resolveAzureSecretReferences({
    environment: readJson(args.environment),
    azureSecretNames: readJson(args["secret-names"]),
    githubSecretsPresent,
  });
  fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    event: "azure_secret_reference_resolution",
    ok: result.ok,
    reusedCount: result.reused.length,
    createCount: result.create.length,
    errors: result.errors,
  }));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({
      event: "azure_secret_reference_resolution",
      ok: false,
      errorClass: error instanceof Error ? error.name : "Error",
    }));
    process.exitCode = 1;
  }
}
