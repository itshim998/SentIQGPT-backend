import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendRoot = resolve(repositoryRoot, "frontend");
const controllerPath = resolve(frontendRoot, "scripts/features/chat-controller.js");
const originalController = readFileSync(controllerPath, "utf8");
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
const DOM_REFS_IMPORT = 'import { getChatDomRefs } from "./chat/dom-refs.js";';
const variants = Object.freeze([
  { name: "baseline", source: originalController },
  {
    name: "controller-with-dom-refs-stubbed",
    source: originalController.replace(DOM_REFS_IMPORT, "const getChatDomRefs = () => ({});"),
  },
  {
    name: "dom-refs-side-effects-only",
    source: `${DOM_REFS_IMPORT}\ngetChatDomRefs();\n`,
  },
  {
    name: "controller-imports-only",
    source: `${originalController.slice(0, originalController.indexOf("// ================================================================"))}\n`,
  },
  {
    name: "controller-imports-with-dom-refs-stubbed",
    source: `${originalController.slice(0, originalController.indexOf("// ================================================================"))}`
      .replace(DOM_REFS_IMPORT, "const getChatDomRefs = () => ({});") + "\n",
  },
]);
let controllerOverride = originalController;

function findChrome() {
  for (const candidate of [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean)) if (existsSync(candidate)) return candidate;
  for (const command of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    try {
      const candidate = execFileSync("which", [command], { encoding: "utf8" }).trim();
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // Continue.
    }
  }
  throw new Error("Chrome was not found.");
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
  const content = filePath === controllerPath ? controllerOverride : readFileSync(filePath);
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
  controllerOverride = variant.source;
  let browser;
  const startedAt = Date.now();
  const errors = [];
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
      else request.abort("blockedbyclient");
    });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${localOrigin}/index.html?controller=${encodeURIComponent(variant.name)}&nonce=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 5_500,
    });
    const state = await page.evaluate(() => ({ readyState: document.readyState, title: document.title }));
    return {
      name: variant.name,
      completed: ["interactive", "complete"].includes(state.readyState),
      durationMs: Date.now() - startedAt,
      state,
      errors,
    };
  } catch (error) {
    browser?.process()?.kill?.("SIGKILL");
    return {
      name: variant.name,
      completed: false,
      durationMs: Date.now() - startedAt,
      error: error?.message || String(error),
      errors,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

const results = [];
for (const variant of variants) results.push(await runVariant(variant));
console.log(JSON.stringify({ results }, null, 2));
await new Promise((resolvePromise) => server.close(resolvePromise));

const baseline = results.find((result) => result.name === "baseline");
const recovered = results.filter((result) => result.name !== "baseline" && result.completed);
if (baseline?.completed) throw new Error("Chat-controller isolation baseline unexpectedly completed.");
if (!recovered.length) throw new Error("No chat-controller isolation variant recovered startup.");
throw new Error(`Chat-controller recovery variants: ${recovered.map((result) => result.name).join(", ")}`);
