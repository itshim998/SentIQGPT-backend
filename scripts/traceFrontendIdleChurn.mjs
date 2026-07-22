import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendRoot = resolve(repositoryRoot, "frontend");
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

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

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
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
  });
  response.end(readFileSync(filePath));
});
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, HOST, resolvePromise);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const origin = `http://${HOST}:${port}`;

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    protocolTimeout: 15_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(origin)) request.continue();
    else request.abort("blockedbyclient");
  });

  await page.evaluateOnNewDocument(() => {
    const state = {
      rafScheduled: 0,
      rafExecuted: 0,
      rafSites: {},
      observers: {},
    };
    const callSite = () => String(new Error().stack || "")
      .split("\n")
      .slice(2, 6)
      .join(" | ") || "unknown";
    const nodeLabel = (node) => {
      if (!(node instanceof Element)) return node?.nodeName || "node";
      const id = node.id ? `#${node.id}` : "";
      const classes = [...node.classList].slice(0, 3).map((name) => `.${name}`).join("");
      return `${node.tagName.toLowerCase()}${id}${classes}`;
    };
    const reset = () => {
      state.rafScheduled = 0;
      state.rafExecuted = 0;
      state.rafSites = {};
      Object.values(state.observers).forEach((observer) => {
        observer.callbacks = 0;
        observer.records = 0;
        observer.signatures = {};
      });
    };
    Object.defineProperty(window, "__sentiqIdleTrace", {
      configurable: false,
      value: { state, reset },
    });

    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const site = callSite();
      state.rafScheduled += 1;
      state.rafSites[site] = (state.rafSites[site] || 0) + 1;
      return nativeRaf((timestamp) => {
        state.rafExecuted += 1;
        callback(timestamp);
      });
    };

    const NativeMutationObserver = window.MutationObserver;
    let sequence = 0;
    window.MutationObserver = class TracedMutationObserver extends NativeMutationObserver {
      constructor(callback) {
        const id = String(++sequence);
        state.observers[id] = { stack: callSite(), callbacks: 0, records: 0, signatures: {} };
        super((records, observer) => {
          const entry = state.observers[id];
          entry.callbacks += 1;
          entry.records += records.length;
          records.forEach((record) => {
            const signature = `${record.type}:${record.attributeName || ""}:${nodeLabel(record.target)}`;
            entry.signatures[signature] = (entry.signatures[signature] || 0) + 1;
          });
          return callback(records, observer);
        });
      }
    };
  });

  await page.goto(`${origin}/index.html?idle-trace=1`, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 10_000 });
  await sleep(2_000);
  await page.evaluate(() => window.__sentiqIdleTrace.reset());
  await sleep(2_000);
  const raw = await page.evaluate(() => structuredClone(window.__sentiqIdleTrace.state));

  const rafSites = Object.entries(raw.rafSites)
    .map(([stack, count]) => ({ count, stack }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 20);
  const observers = Object.entries(raw.observers)
    .map(([id, observer]) => ({
      id,
      stack: observer.stack,
      callbacks: observer.callbacks,
      records: observer.records,
      signatures: Object.entries(observer.signatures)
        .map(([signature, count]) => ({ signature, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 12),
    }))
    .filter((observer) => observer.callbacks || observer.records)
    .sort((left, right) => right.records - left.records)
    .slice(0, 20);

  console.log(JSON.stringify({
    idleWindowSeconds: 2,
    rafScheduled: raw.rafScheduled,
    rafExecuted: raw.rafExecuted,
    rafSites,
    observers,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
