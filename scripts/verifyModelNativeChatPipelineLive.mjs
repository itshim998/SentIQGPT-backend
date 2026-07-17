import { spawn } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const pythonPort = "3322";
const token = "model-native-chat-pipeline-local-only";
const flags = [
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
  LLM_SERVICE_HOST: "127.0.0.1",
  LLM_SERVICE_PORT: pythonPort,
  LLM_SERVICE_URL: `http://127.0.0.1:${pythonPort}`,
  SENTIQ_INTERNAL_SERVICE_TOKEN: token,
  TS_NODE_PROJECT: "tsconfig.backend.json",
};
for (const name of flags) env[name] = "true";

const children = [];
function start(command, args, stdio = "ignore") {
  const child = spawn(command, args, { cwd: root, env, stdio, windowsHide: true, shell: false });
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

async function waitForReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${pythonPort}/llm/health/details`, {
        headers: { "X-SentIQ-Internal-Token": token },
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Local LLM gateway readiness timed out");
}

try {
  start(process.platform === "win32" ? "python" : "python3", ["backend/llm_service.py"]);
  await waitForReady();
  const child = start(process.execPath, ["-r", "ts-node/register", "backend/verifyModelNativeChatPipeline.ts"], "inherit");
  const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (error) {
  console.error(JSON.stringify({
    status: "FAIL",
    check: "model_native_chat_pipeline",
    error_class: error instanceof Error ? error.name : "Error",
  }));
  process.exitCode = 1;
} finally {
  await Promise.all(children.reverse().map(stop));
}
