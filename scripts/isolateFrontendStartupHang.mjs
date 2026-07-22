import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendRoot = resolve(repositoryRoot, "frontend");
const domRefsPath = resolve(frontendRoot, "scripts/features/chat/dom-refs.js");
const originalDomRefs = readFileSync(domRefsPath, "utf8");
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

const SUSPECT_IMPORTS = Object.freeze([
  "../attention-management.js",
  "../frame-discipline.js",
  "../long-conversation-optimizer.js",
  "../citation-expansion-rehydration.js",
  "../asset-font-loading.js",
  "../mobile-navigation.js",
  "../mobile-composer.js",
  "../touch-interaction-language.js",
  "../mobile-glass-budget.js",
  "../mobile-rich-content.js",
  "../motion-grammar.js",
  "../compositor-safety.js",
  "../blur-layer-budget.js",
  "../accessibility-verification.js",
  "../accessibility-verification-dynamic.js",
]);

let domRefsOverride = originalDomRefs;

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

function fileFor(requestUrl = "/") {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(frontendRoot, normalize(relative));
  return candidate.startsWith(`${frontendRoot}/`) ? { candidate, pathname } : null;
}

function variantSource(disabledImports = []) {
  let source = originalDomRefs;
  for (const importPath of disabledImports) {
    const statement = `import "${importPath}";`;
    if (!source.includes(statement)) throw new Error(`Missing expected import ${statement}`);
    source = source.replace(statement, `// startup-isolation disabled ${importPath}`);
  }
  return source;
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const server = createServer((request, response) => {
  const resolved = fileFor(request.url);
  if (!resolved || !existsSync(resolved.candidate) || !statSync(resolved.candidate).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const content = resolved.candidate === domRefsPath ? domRefsOverride : readFileSync(resolved.candidate);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": MIME[extname(resolved.candidate).toLowerCase()] || "application/octet-stream",
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

async function runVariant(name, disabledImports) {
  domRefsOverride = variantSource(disabledImports);
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
    const url = `${localOrigin}/index.html?isolation=${encodeURIComponent(name)}&nonce=${Date.now()}`;
    await withTimeout(page.goto(url, { waitUntil: "domcontentloaded", timeout: 5_500 }), 6_500, name);
    const state = await withTimeout(page.evaluate(() => ({
      readyState: document.readyState,
      title: document.title,
      bodyChildren: document.body?.children?.length || 0,
    })), 2_000, `${name}:evaluate`);
    return {
      name,
      disabledImports,
      completed: state.readyState === "interactive" || state.readyState === "complete",
      durationMs: Date.now() - startedAt,
      state,
      errors,
      blockedExternal: [...new Set(blockedExternal)],
    };
  } catch (error) {
    browser?.process()?.kill?.("SIGKILL");
    return {
      name,
      disabledImports,
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
results.push(await runVariant("baseline", []));
for (const importPath of SUSPECT_IMPORTS) {
  results.push(await runVariant(`without:${importPath}`, [importPath]));
}

const recovered = results.filter((result) => result.name !== "baseline" && result.completed);
console.log(JSON.stringify({
  baseline: results[0],
  recovered,
  results,
}, null, 2));

await new Promise((resolvePromise) => server.close(resolvePromise));

if (results[0].completed) {
  throw new Error("Startup isolation baseline completed after external requests were blocked; the prior CI timeout was externally induced.");
}
if (recovered.length !== 1) {
  throw new Error(`Startup isolation expected one recovering import, found ${recovered.length}.`);
}
throw new Error(`Startup hang isolated to ${recovered[0].disabledImports[0]}.`);
