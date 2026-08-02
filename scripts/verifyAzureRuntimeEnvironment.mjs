import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

export const CANONICAL_MODEL_TOOL_ENVIRONMENT_NAMES = Object.freeze([
  "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
  "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
]);

export const LEGACY_ROLLBACK_ALLOWED_MISSING_CHECKS = Object.freeze([
  "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED_PRESENT",
]);

const LEGACY_ROLLBACK_ALLOWED_MISSING_CHECK_SET = new Set(
  LEGACY_ROLLBACK_ALLOWED_MISSING_CHECKS,
);

function present(environment, name) {
  return String(environment[name] ?? "").trim().length > 0;
}

function normalizeAllowedMissingChecks(values = []) {
  const input = Array.isArray(values) ? values : [values];
  const normalized = input
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  for (const name of normalized) {
    if (!LEGACY_ROLLBACK_ALLOWED_MISSING_CHECK_SET.has(name)) {
      throw new Error(`Unsupported runtime compatibility exception: ${name}`);
    }
  }

  return new Set(normalized);
}

export function verifyAzureRuntimeEnvironment(
  environment = process.env,
  options = {},
) {
  const allowedMissingChecks = normalizeAllowedMissingChecks(
    options.allowedMissingChecks ?? [],
  );

  const checks = {
    SUPABASE_URL_1_PRESENT: present(environment, "SUPABASE_URL_1"),
    SUPABASE_URL_1_HTTPS: (() => {
      try {
        const parsed = new URL(String(environment.SUPABASE_URL_1 ?? "").trim());
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    })(),
    SENTIQ_INTERNAL_SERVICE_TOKEN_PRESENT: present(
      environment,
      "SENTIQ_INTERNAL_SERVICE_TOKEN",
    ),
    DATABASE_CONFIGURATION_AVAILABLE: (
      present(environment, "SUPABASE_URL_1")
      && present(environment, "SUPABASE_SERVICE_ROLE_KEY_1")
      && present(environment, "SUPABASE_ANON_KEY_1")
    ),
    UNSAFE_INTERNAL_ENDPOINTS_DISABLED: (
      String(environment.SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS ?? "")
        .trim()
        .toLowerCase() !== "true"
    ),
  };

  for (const name of CANONICAL_MODEL_TOOL_ENVIRONMENT_NAMES) {
    checks[`${name}_PRESENT`] = present(environment, name);
  }

  const allFailedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
    .sort();

  const compatibilityExceptions = allFailedChecks
    .filter((name) => allowedMissingChecks.has(name));

  const failedChecks = allFailedChecks
    .filter((name) => !allowedMissingChecks.has(name));

  return Object.freeze({
    event: "azure_runtime_environment",
    ok: failedChecks.length === 0,
    checks: Object.freeze({ ...checks }),
    failedChecks: Object.freeze(failedChecks),
    compatibilityExceptions: Object.freeze(compatibilityExceptions),
  });
}

function buildPythonProbeSource(options = {}) {
  const names = JSON.stringify(CANONICAL_MODEL_TOOL_ENVIRONMENT_NAMES);
  const allowLegacyPollinations = normalizeAllowedMissingChecks(
    options.allowedMissingChecks ?? [],
  ).has("SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED_PRESENT")
    ? 1
    : 0;

  return [
    "import json,os,urllib.parse as u",
    `n=${names}`,
    `a=${allowLegacyPollinations}`,
    "v=lambda x:os.getenv(x,'').strip()",
    "p=u.urlparse(v('SUPABASE_URL_1'))",
    "c={'SUPABASE_URL_1_PRESENT':bool(v('SUPABASE_URL_1')),'SUPABASE_URL_1_HTTPS':p.scheme=='https' and not p.username and not p.password,'SENTIQ_INTERNAL_SERVICE_TOKEN_PRESENT':bool(v('SENTIQ_INTERNAL_SERVICE_TOKEN')),'DATABASE_CONFIGURATION_AVAILABLE':all(v(x) for x in ('SUPABASE_URL_1','SUPABASE_SERVICE_ROLE_KEY_1','SUPABASE_ANON_KEY_1')),'UNSAFE_INTERNAL_ENDPOINTS_DISABLED':v('SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS').lower()!='true'}",
    "c.update({x+'_PRESENT':bool(v(x)) for x in n})",
    "f=sorted(k for k,z in c.items() if not z)",
    "x='SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED_PRESENT'",
    "e=[x] if a and x in f else []",
    "f=[k for k in f if k not in e]",
    "print(json.dumps({'event':'azure_runtime_environment','ok':not f,'checks':c,'failedChecks':f,'compatibilityExceptions':e},separators=(',',':'),sort_keys=True))",
  ].join(";");
}
export function buildAzureRuntimeProbeCommand(options = {}) {
  const encoded = Buffer.from(
    buildPythonProbeSource(options),
    "utf8",
  ).toString("base64");

  const command = `python -c exec(__import__('base64').b64decode('${encoded}'))`;

  if (command.length > 2_000) {
    throw new Error("The Azure runtime probe command exceeds the safe exec URL budget.");
  }

  return command;
}

function readAllowedMissingChecks(argv) {
  const inline = argv.find((argument) => argument.startsWith("--allow-missing="));
  if (inline) {
    return inline.slice("--allow-missing=".length).split(",");
  }

  const index = argv.indexOf("--allow-missing");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--allow-missing requires a check name.");
    }
    return value.split(",");
  }

  return [];
}

function main() {
  const argv = process.argv.slice(2);
  const allowedMissingChecks = readAllowedMissingChecks(argv);

  if (argv.includes("--emit-command")) {
    console.log(buildAzureRuntimeProbeCommand({ allowedMissingChecks }));
    return;
  }

  const report = verifyAzureRuntimeEnvironment(process.env, {
    allowedMissingChecks,
  });

  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({
      event: "azure_runtime_environment",
      ok: false,
      errorClass: error instanceof Error ? error.name : "Error",
    }));
    process.exitCode = 1;
  }
}
