import { spawn } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const nodePort = "3311";
const pythonPort = "3312";
const token = "model-native-startup-smoke-local-only";
const canonicalFlags = [
  "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
  "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
];
const env = {
  ...process.env,
  PORT: nodePort,
  LLM_SERVICE_HOST: "127.0.0.1",
  LLM_SERVICE_PORT: pythonPort,
  LLM_SERVICE_URL: `http://127.0.0.1:${pythonPort}`,
  SENTIQ_INTERNAL_SERVICE_TOKEN: token,
  TS_NODE_PROJECT: "tsconfig.backend.json",
};
for (const name of canonicalFlags) env[name] = "true";

const children = [];
function start(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  children.push(child);
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function waitForJson(url, headers = {}, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
    } catch {
      // The processes are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Local stack readiness timed out");
}

try {
  const python = process.platform === "win32" ? "python" : "python3";
  start(python, ["backend/llm_service.py"]);
  const details = await waitForJson(
    `http://127.0.0.1:${pythonPort}/llm/health/details`,
    { "X-SentIQ-Internal-Token": token },
  );
  const runtime = details?.model_tool_runtime;
  if (!runtime?.google_genai_sdk_available || runtime.gemini_sdk_path !== "google_genai") {
    throw new Error("Google GenAI readiness is unavailable");
  }
  if (!runtime.groq_buffered_capable || !runtime.groq_streaming_capable || !runtime.gemini_buffered_capable) {
    throw new Error("Expected model-tool capabilities are unavailable");
  }
  for (const name of canonicalFlags) {
    if (runtime.canonical_flags?.[name] !== true) throw new Error("Canonical runtime flag mismatch");
  }

  start(process.execPath, ["-r", "ts-node/register", "backend/server.ts"]);
  const ready = await waitForJson(`http://127.0.0.1:${nodePort}/ready`);
  if (JSON.stringify(ready) !== JSON.stringify({ status: "ready" })) {
    throw new Error("Public readiness payload exposed internal details");
  }
  console.log("PASS | isolated Node and FastAPI startup/readiness checks completed.");
} catch (error) {
  console.error(JSON.stringify({
    status: "FAIL",
    check: "model_native_stack_startup",
    error_class: error instanceof Error ? error.name : "Error",
  }));
  process.exitCode = 1;
} finally {
  await Promise.all(children.reverse().map(stop));
}
