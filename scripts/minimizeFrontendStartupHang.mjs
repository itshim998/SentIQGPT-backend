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
const ALL_IMPORTS = Object.freeze([
  "../ui-state-runtime.js",
  "../authentication-surface.js",
  "../settings-workspace.js",
  "../live-surface.js",
  "../adaptive-panel-framework.js",
  "../panel-focus-recovery.js",
  "../compact-user-messages.js",
  "../identity-metadata.js",
  "../message-action-behaviour.js",
  "../long-answer-reading.js",
  "../websurf-presentation-refinement.js",
  "../deep-research-workspace.js",
  "../asset-result-presentation.js",
  "../semantic-activity-progress.js",
  "../failure-recovery.js",
  "../ui-state-bridge.js",
  "../progressive-disclosure.js",
  "../capability-awareness.js",
  "../conversation-continuity.js",
  "../conversation-continuity-event-bridge.js",
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

function sourceWithEnabledImports(enabledImports) {
  const enabled = new Set(enabledImports);
  let source = originalDomRefs;
  for (const importPath of ALL_IMPORTS) {
    if (enabled.has(importPath)) continue;
    const statement = `import "${importPath}";`;
    if (!source.includes(statement)) throw new Error(`Missing expected import ${statement}`);
    source = source.replace(statement, `// delta-debug disabled ${importPath}`);
  }
  return source;
}

function fileFor(requestUrl = "/") {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(frontendRoot, normalize(relative));
  return candidate.startsWith(`${frontendRoot}/`) ? candidate : null;
}

function splitInto(items, count) {
  const chunks = [];
  const size = Math.ceil(items.length / count);
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

const server = createServer((request, response) => {
  const filePath = fileFor(request.url);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const content = filePath === domRefsPath ? domRefsOverride : readFileSync(filePath);
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
const attempts = [];
let attemptSequence = 0;

async function testEnabled(enabledImports, label) {
  domRefsOverride = sourceWithEnabledImports(enabledImports);
  let browser;
  const startedAt = Date.now();
  const errors = [];
  const attempt = {
    sequence: ++attemptSequence,
    label,
    enabledCount: enabledImports.length,
    enabledImports: [...enabledImports],
  };
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      protocolTimeout: 7_000,
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
    await page.goto(`${localOrigin}/index.html?dd=${attempt.sequence}&nonce=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 4_500,
    });
    attempt.hangs = false;
    attempt.durationMs = Date.now() - startedAt;
    attempt.errors = errors;
  } catch (error) {
    browser?.process()?.kill?.("SIGKILL");
    attempt.hangs = true;
    attempt.durationMs = Date.now() - startedAt;
    attempt.error = error?.message || String(error);
    attempt.errors = errors;
  } finally {
    await browser?.close().catch(() => {});
  }
  attempts.push(attempt);
  console.log(`[delta-debug] ${label}: ${attempt.hangs ? "HANG" : "PASS"} (${enabledImports.length} enabled, ${attempt.durationMs}ms)`);
  return attempt.hangs;
}

let current = [...ALL_IMPORTS];
if (!(await testEnabled(current, "baseline-all"))) throw new Error("Delta-debug baseline did not reproduce the startup hang.");
if (await testEnabled([], "no-side-effects")) throw new Error("Startup hangs even with every dom-refs side effect disabled.");

let granularity = 2;
while (current.length >= 2) {
  const chunks = splitInto(current, granularity);
  let reduced = false;

  for (let index = 0; index < chunks.length; index += 1) {
    const subset = chunks[index];
    if (await testEnabled(subset, `subset-${granularity}-${index + 1}`)) {
      current = subset;
      granularity = Math.max(2, granularity - 1);
      reduced = true;
      break;
    }
  }
  if (reduced) continue;

  for (let index = 0; index < chunks.length; index += 1) {
    const removed = new Set(chunks[index]);
    const complement = current.filter((item) => !removed.has(item));
    if (!complement.length) continue;
    if (await testEnabled(complement, `complement-${granularity}-${index + 1}`)) {
      current = complement;
      granularity = Math.max(2, granularity - 1);
      reduced = true;
      break;
    }
  }
  if (reduced) continue;

  if (granularity >= current.length) break;
  granularity = Math.min(current.length, granularity * 2);
}

const verification = [];
for (const importPath of current) {
  const candidate = current.filter((item) => item !== importPath);
  verification.push({ importPath, hangsWithout: candidate.length ? await testEnabled(candidate, `verify-without:${importPath}`) : false });
}

const report = {
  minimalEnabledSet: current,
  minimalEnabledCount: current.length,
  verification,
  attemptCount: attempts.length,
  attempts,
};
console.log(JSON.stringify(report, null, 2));
await new Promise((resolvePromise) => server.close(resolvePromise));
throw new Error(`Minimal startup hang set (${current.length}): ${current.join(", ")}`);
