import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(repositoryRoot, "package.json");
const lockfilePath = resolve(repositoryRoot, "package-lock.json");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));

const productionDependencies = packageJson.dependencies ?? {};
const lockRootDependencies = lockfile.packages?.[""]?.dependencies ?? {};
const lockPdfkit = lockfile.packages?.["node_modules/pdfkit"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(Object.prototype.hasOwnProperty.call(productionDependencies, "pdfkit"),
  "pdfkit must be declared in production dependencies.");
assert(productionDependencies.pdfkit === "^0.18.0",
  `Unexpected pdfkit dependency range: ${String(productionDependencies.pdfkit)}.`);
assert(lockRootDependencies.pdfkit === productionDependencies.pdfkit,
  "package-lock root dependencies do not match package.json for pdfkit.");
assert(lockPdfkit && lockPdfkit.version === "0.18.0",
  "package-lock must contain pdfkit 0.18.0.");
assert(lockPdfkit.dev !== true,
  "pdfkit must not be marked dev-only in package-lock.json.");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

const tempRoot = mkdtempSync(resolve(tmpdir(), "sentiq-production-startup-"));
const runtimePort = 38080 + Math.floor(Math.random() * 1000);
let child = null;

try {
  cpSync(repositoryRoot, tempRoot, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repositoryRoot.length + 1).replaceAll("\\", "/");
      return relative !== "node_modules"
        && !relative.startsWith("node_modules/")
        && relative !== ".git"
        && !relative.startsWith(".git/")
        && relative !== "dist"
        && !relative.startsWith("dist/");
    },
  });

  run("npm", ["ci"], { cwd: tempRoot });
  run("npm", ["run", "build"], { cwd: tempRoot });
  run("npm", ["ci", "--omit=dev"], { cwd: tempRoot });

  const runtimePackagePath = resolve(tempRoot, "package.json");
  const runtimeLockPath = resolve(tempRoot, "package-lock.json");
  const runtimePackage = JSON.parse(readFileSync(runtimePackagePath, "utf8"));
  const runtimeLock = JSON.parse(readFileSync(runtimeLockPath, "utf8"));
  assert(runtimePackage.dependencies?.pdfkit === "^0.18.0", "Clean-room install lost pdfkit production dependency.");
  assert(runtimeLock.packages?.["node_modules/pdfkit"]?.dev !== true, "Clean-room lockfile marked pdfkit dev-only.");
  assert(existsSync(resolve(tempRoot, "node_modules/pdfkit")), "Clean-room production install is missing node_modules/pdfkit.");

  const startupScript = resolve(tempRoot, ".pass3-startup-probe.mjs");
  writeFileSync(startupScript, `import "./dist/backend/server.js";\n`, "utf8");

  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(runtimePort),
    LLM_SERVICE_PORT: String(runtimePort + 1),
    LLM_SERVICE_HOST: "127.0.0.1",
    LLM_SERVICE_URL: `http://127.0.0.1:${runtimePort + 1}`,
    SENTIQ_INTERNAL_SERVICE_TOKEN: "pass3-startup-test-token",
    SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS: "false",
    SUPABASE_URL_1: "https://example.supabase.co",
    SUPABASE_URL_2: "https://example.supabase.co",
    SUPABASE_URL_3: "https://example.supabase.co",
    SUPABASE_URL_4: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY_1: "pass3-test-service-role-1",
    SUPABASE_SERVICE_ROLE_KEY_2: "pass3-test-service-role-2",
    SUPABASE_SERVICE_ROLE_KEY_3: "pass3-test-service-role-3",
    SUPABASE_SERVICE_ROLE_KEY_4: "pass3-test-service-role-4",
    SUPABASE_ANON_KEY_1: "pass3-test-anon-1",
    SUPABASE_ANON_KEY_2: "pass3-test-anon-2",
    SUPABASE_ANON_KEY_3: "pass3-test-anon-3",
    SUPABASE_ANON_KEY_4: "pass3-test-anon-4",
    CORS_ORIGINS: "http://127.0.0.1",
    SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED: "false",
  };

  child = spawn(process.execPath, [startupScript], {
    cwd: tempRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const deadline = Date.now() + 15_000;
  let healthResponse = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Compiled production server exited before /health became available (exit ${child.exitCode}).\n${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        healthResponse = await response.json();
        break;
      }
    } catch {
      // Server is still booting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  assert(healthResponse?.status === "ok", `Production startup did not expose a healthy /health response.\nstdout=${stdout}\nstderr=${stderr}`);
  assert(child.exitCode === null, "Production server exited after becoming healthy.");
  console.log(JSON.stringify({
    event: "production_startup_smoke",
    ok: true,
    dependency: "pdfkit@0.18.0",
    cleanRoomInstall: true,
    healthStatus: healthResponse.status,
  }));
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
  }
  if (child) {
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolvePromise();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
