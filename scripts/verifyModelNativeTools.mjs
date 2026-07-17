import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const python = process.platform === "win32" ? "python" : "python3";
const live = process.argv.slice(2).includes("--live");

const offlineChecks = [
  ["typescript_build", npm, ["run", "build"]],
  ["python_compile", python, ["-m", "py_compile", "llm_adapter.py", "backend/llm_service.py", "backend/testModelToolProviderTransport.py", "backend/verifyModelNativeToolsLive.py"]],
  ["frontend_syntax", npm, ["run", "check:frontend-syntax"]],
  ["configuration", npm, ["run", "test:model-tool-configuration"]],
  ["azure_renderer", npm, ["run", "test:azure-container-renderer"]],
  ["tool_contract", npm, ["run", "test:model-tool-contract"]],
  ["provider_transport", npm, ["run", "test:model-tool-transport"]],
  ["capability_routing", npm, ["run", "test:model-capability-routing"]],
  ["recovery_and_claims", npm, ["run", "test:model-tool-execution"]],
  ["memory_safety", npm, ["run", "test:model-memory-safety"]],
  ["image_safety", npm, ["run", "test:image-routing-safety"]],
  ["normalized_lifecycle", npm, ["run", "test:model-native-lifecycle"]],
  ["frontend_lifecycle", npm, ["run", "test:frontend-tool-lifecycle"]],
  ["websurf", npm, ["run", "test:web-search"]],
  ["websurf_persistence", npm, ["run", "test:websurf-v2-persistence"]],
  ["file_generation", npm, ["run", "test:file-generation"]],
  ["frontend_file_generation", npm, ["run", "test:frontend-file-generation"]],
  ["conversation_sync", npm, ["run", "test:conversation-sync"]],
  ["timeout_safety", npm, ["run", "test:safety-timeout"]],
  ["pipeline", npm, ["run", "test:pipeline"]],
  ["golden_evaluation", npm, ["run", "eval:golden"]],
  ["diff_whitespace", "git", ["diff", "--check"]],
];

const canonicalLiveEnvironment = {
  SENTIQ_MODEL_TOOL_REGISTRY_ENABLED: "true",
  SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_IMAGE_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_CHART_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_FILE_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_MEMORY_SELECTION_ENABLED: "true",
  SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED: "true",
};

function runCheck([name, command, args], env = process.env) {
  console.log(`\n[model-native-verify] START ${name}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const status = result.status === 0 ? "PASS" : "FAIL";
  console.log(`[model-native-verify] ${status} ${name}`);
  return { name, status, exitCode: result.status ?? 1 };
}

const rows = [];
for (const check of offlineChecks) {
  const row = runCheck(check);
  rows.push(row);
  if (row.status === "FAIL") break;
}

if (rows.every((row) => row.status === "PASS") && live) {
  const liveEnvironment = { ...process.env, ...canonicalLiveEnvironment };
  const liveChecks = [
    ["live_stack_startup_readiness", npm, ["run", "verify:model-native-stack-startup-live"]],
    ["live_chat_pipeline", npm, ["run", "verify:model-native-chat-pipeline-live"]],
    ["live_executor_matrix", npm, ["run", "verify:model-native-executors-live"]],
    ["live_memory_migration_prerequisite", npm, ["run", "verify:model-native-memory-migration-live"]],
  ];
  for (const check of liveChecks) {
    const row = runCheck(check, liveEnvironment);
    rows.push(row);
    if (row.status === "FAIL") break;
  }
}

console.log("\nModel-native verification matrix");
for (const row of rows) console.log(`${row.status.padEnd(4)} ${row.name}`);
if (!live && rows.every((row) => row.status === "PASS")) {
  console.log("PASS offline_release_gate (live provider behavior not exercised)");
}

process.exit(rows.every((row) => row.status === "PASS") ? 0 : 1);
