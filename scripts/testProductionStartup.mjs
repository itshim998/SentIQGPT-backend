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

assert(productionDependencies.pdfkit === "^0.18.0", "pdfkit must be a production dependency at ^0.18.0.");
assert(lockRootDependencies.pdfkit === productionDependencies.pdfkit, "package.json/package-lock pdfkit declarations differ.");
assert(lockPdfkit?.version === "0.18.0", "package-lock must resolve pdfkit 0.18.0.");
assert(lockPdfkit?.dev !== true, "pdfkit must not be marked dev-only in package-lock.json.");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}.`);
}

const tempRoot = mkdtempSync(resolve(tmpdir(), "sentiq-production-startup-"));
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

  run("npm", ["ci"], tempRoot);
  run("npm", ["run", "build"], tempRoot);
  run("npm", ["ci", "--omit=dev"], tempRoot);

  assert(existsSync(resolve(tempRoot, "node_modules/pdfkit")), "Production dependency install is missing pdfkit.");

  const probePath = resolve(tempRoot, ".pass3-startup-probe.mjs");
  writeFileSync(probePath, [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    "require.resolve('pdfkit');",
    "await import('./dist/backend/tools/fileGeneration/pdfDocument.js');",
    "await import('./dist/backend/server.js');",
    "setTimeout(() => process.exit(0), 1000).unref();",
  ].join("\n"), "utf8");

  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: "38173",
    LLM_SERVICE_PORT: "38174",
    LLM_SERVICE_HOST: "127.0.0.1",
    LLM_SERVICE_URL: "http://127.0.0.1:38174",
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
    SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED: "false",
  };

  child = spawn(process.execPath, [probePath], {
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

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  assert(child.exitCode === 0,
    `Production dependency/startup module graph failed before the probe completed (exit ${String(child.exitCode)}).\nstdout=${stdout}\nstderr=${stderr}`);

  console.log(JSON.stringify({
    event: "production_startup_dependency_smoke",
    ok: true,
    cleanRoomInstall: true,
    pdfkit: "0.18.0",
    compiledServerModuleLoaded: true,
    note: "The full server intentionally gates app.listen() on live shard migration verification; this smoke test validates the production dependency and module-load phase without requiring live databases.",
  }));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (child) {
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolvePromise();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
