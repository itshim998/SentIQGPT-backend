import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendRoot = resolve(repositoryRoot, "frontend");
const indexPath = resolve(frontendRoot, "index.html");
const originalIndex = readFileSync(indexPath, "utf8");
const HOST = "127.0.0.1";
const MIME = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

const VARIANTS = Object.freeze([
  { name: "baseline", transforms: [] },
  { name: "without-main-module", transforms: ["main-module"] },
  { name: "without-main-styles", transforms: ["main-styles"] },
  { name: "without-main-module-and-styles", transforms: ["main-module", "main-styles"] },
  { name: "without-vendor-scripts", transforms: ["vendor-scripts"] },
  { name: "without-all-scripts", transforms: ["main-module", "vendor-scripts", "bootstrap-guard"] },
  { name: "without-all-scripts-and-main-styles", transforms: ["main-module", "vendor-scripts", "bootstrap-guard", "main-styles"] },
]);

let indexOverride = originalIndex;

function findChrome() {
  for (const candidate of [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  for (const command of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    try {
      const candidate = execFileSync("which", [command], { encoding: "utf8" }).trim();
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // Continue through known browser names.
    }
  }
  throw new Error("Chrome was not found.");
}

function applyTransforms(transforms = []) {
  let source = originalIndex;
  if (transforms.includes("main-module")) {
    source = source.replace(/\s*<script id="sentiq-main-module"[^>]*><\/script>/, "\n  <!-- shell-isolation: main module removed -->");
  }
  if (transforms.includes("main-styles")) {
    source = source.replace(/\s*<link rel="stylesheet" href="styles\/main\.css">/, "\n  <!-- shell-isolation: main stylesheet removed -->");
  }
  if (transforms.includes("bootstrap-guard")) {
    source = source.replace(/\s*<script src="scripts\/bootstrap-guard\.js"><\/script>/, "\n  <!-- shell-isolation: bootstrap guard removed -->");
  }
  if (transforms.includes("vendor-scripts")) {
    source = source
      .replace(/\s*<script src="vendor\/marked\/marked\.min\.js"><\/script>/, "")
      .replace(/\s*<script src="vendor\/katex\/katex\.min\.js"><\/script>/, "")
      .replace(/\s*<script src="vendor\/supabase\/supabase\.js"><\/script>/, "");
  }
  return source;
}

function fileFor(requestUrl = "/") {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(frontendRoot, normalize(relative));
  return candidate.startsWith(`${frontendRoot}/`) ? candidate : null;
}

const server = createServer((request, response) => {
  const filePath = fileFor(request.url);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const content = filePath === indexPath ? indexOverride : readFileSync(filePath);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
  });
  response.end(content);
});
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, HOST, resolvePromise);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const localOrigin = `http://${HOST}:${port}`;
const executablePath = findChrome();

async function runVariant(variant) {
  indexOverride = applyTransforms(variant.transforms);
  let browser;
  const startedAt = Date.now();
  const errors = [];
  const blockedExternal = [];
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      protocolTimeout: 8_000,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error?.message || String(error)));
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().startsWith(localOrigin)) request.continue();
      else {
        blockedExternal.push(request.url());
        request.abort("blockedbyclient");
      }
    });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const url = `${localOrigin}/index.html?shell=${encodeURIComponent(variant.name)}&nonce=${Date.now()}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5_500 });
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      title: document.title,
      bodyChildren: document.body?.children?.length || 0,
      mainModulePresent: Boolean(document.getElementById("sentiq-main-module")),
    }));
    return {
      ...variant,
      completed: ["interactive", "complete"].includes(state.readyState),
      durationMs: Date.now() - startedAt,
      state,
      errors,
      blockedExternal: [...new Set(blockedExternal)],
    };
  } catch (error) {
    browser?.process()?.kill?.("SIGKILL");
    return {
      ...variant,
      completed: false,
      durationMs: Date.now() - startedAt,
      error: error?.message || String(error),
      errors,
      blockedExternal: [...new Set(blockedExternal)],
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

const results = [];
for (const variant of VARIANTS) results.push(await runVariant(variant));
console.log(JSON.stringify({ results }, null, 2));
await new Promise((resolvePromise) => server.close(resolvePromise));

const baseline = results.find((result) => result.name === "baseline");
const recovered = results.filter((result) => result.name !== "baseline" && result.completed);
if (baseline?.completed) throw new Error("Shell isolation baseline unexpectedly completed.");
if (!recovered.length) throw new Error("No shell variant recovered DOMContentLoaded.");
throw new Error(`Shell recovery variants: ${recovered.map((result) => result.name).join(", ")}`);
