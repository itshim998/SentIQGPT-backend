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

function present(environment, name) {
  return String(environment[name] ?? "").trim().length > 0;
}

export function verifyAzureRuntimeEnvironment(environment = process.env) {
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
    SENTIQ_INTERNAL_SERVICE_TOKEN_PRESENT: present(environment, "SENTIQ_INTERNAL_SERVICE_TOKEN"),
    DATABASE_CONFIGURATION_AVAILABLE: (
      present(environment, "SUPABASE_URL_1")
      && present(environment, "SUPABASE_SERVICE_ROLE_KEY_1")
      && present(environment, "SUPABASE_ANON_KEY_1")
    ),
    UNSAFE_INTERNAL_ENDPOINTS_DISABLED: (
      String(environment.SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS ?? "").trim().toLowerCase() !== "true"
    ),
  };
  for (const name of CANONICAL_MODEL_TOOL_ENVIRONMENT_NAMES) {
    checks[`${name}_PRESENT`] = present(environment, name);
  }
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return Object.freeze({
    event: "azure_runtime_environment",
    ok: failedChecks.length === 0,
    checks: Object.freeze({ ...checks }),
    failedChecks: Object.freeze(failedChecks),
  });
}

function buildPythonProbeSource() {
  const names = JSON.stringify(CANONICAL_MODEL_TOOL_ENVIRONMENT_NAMES);
  return [
    "import json,os,urllib.parse",
    `names=${names}`,
    "value=lambda name:os.environ.get(name,'').strip()",
    "url=urllib.parse.urlparse(value('SUPABASE_URL_1'))",
    "checks={'SUPABASE_URL_1_PRESENT':bool(value('SUPABASE_URL_1')),'SUPABASE_URL_1_HTTPS':url.scheme=='https' and not url.username and not url.password,'SENTIQ_INTERNAL_SERVICE_TOKEN_PRESENT':bool(value('SENTIQ_INTERNAL_SERVICE_TOKEN')),'DATABASE_CONFIGURATION_AVAILABLE':all(value(name) for name in ('SUPABASE_URL_1','SUPABASE_SERVICE_ROLE_KEY_1','SUPABASE_ANON_KEY_1')),'UNSAFE_INTERNAL_ENDPOINTS_DISABLED':value('SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS').lower()!='true'}",
    "checks.update({name+'_PRESENT':bool(value(name)) for name in names})",
    "failed=sorted(name for name,passed in checks.items() if not passed)",
    "print(json.dumps({'event':'azure_runtime_environment','ok':not failed,'checks':checks,'failedChecks':failed},sort_keys=True))",
  ].join("\n");
}

export function buildAzureRuntimeProbeCommand() {
  const encoded = Buffer.from(buildPythonProbeSource(), "utf8").toString("base64");
  const command = `python -c exec(__import__('base64').b64decode('${encoded}'))`;
  if (command.length > 2_000) {
    throw new Error("The Azure runtime probe command exceeds the safe exec URL budget.");
  }
  return command;
}

function main() {
  if (process.argv.includes("--emit-command")) {
    console.log(buildAzureRuntimeProbeCommand());
    return;
  }
  const report = verifyAzureRuntimeEnvironment(process.env);
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
