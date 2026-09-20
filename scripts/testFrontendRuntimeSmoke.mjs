import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendRoot = resolve(repositoryRoot, "frontend");
const HOST = "127.0.0.1";
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function findChromeExecutable() {
  const configured = String(process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  const candidates = [
    configured,
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const command of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    try {
      const resolved = execFileSync("which", [command], { encoding: "utf8" }).trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch {
      // Try the next known executable.
    }
  }
  throw new Error("No Chrome or Chromium executable was found for the frontend runtime smoke test.");
}

function safeFilePath(requestUrl = "/") {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(frontendRoot, normalize(relativePath));
  const relCandidate = relative(frontendRoot, candidate);
  return !relCandidate.startsWith("..") && !isAbsolute(relCandidate) ? candidate : null;
}

function createStaticServer() {
  return createServer((request, response) => {
    const filePath = safeFilePath(request.url);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
    });
    response.end(readFileSync(filePath));
  });
}

function metricValue(metrics, name) {
  return metrics.metrics.find((metric) => metric.name === name)?.value || 0;
}

function delta(after, before, key) {
  return Number(after?.[key] || 0) - Number(before?.[key] || 0);
}

function summarizeObservers(after = {}, before = {}) {
  return Object.entries(after)
    .map(([id, observer]) => ({
      id,
      callbacks: Number(observer.callbacks || 0) - Number(before?.[id]?.callbacks || 0),
      records: Number(observer.records || 0) - Number(before?.[id]?.records || 0),
      stack: observer.stack || "",
    }))
    .filter((observer) => observer.callbacks > 0 || observer.records > 0)
    .sort((left, right) => right.records - left.records || right.callbacks - left.callbacks)
    .slice(0, 8);
}

const server = createStaticServer();
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, HOST, resolvePromise);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const localOrigin = `http://${HOST}:${port}`;
const url = `${localOrigin}/index.html?runtime-smoke=1`;

let browser;
try {
  const executablePath = findChromeExecutable();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 15_000,
    args: [
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--disable-sync",
      "--no-first-run",
      "--no-sandbox",
      "--password-store=basic",
      "--use-mock-keychain",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(15_000);
  page.setDefaultTimeout(8_000);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const consoleErrors = [];
  const pageErrors = [];
  const blockedExternal = new Set();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(localOrigin)) request.continue();
    else {
      blockedExternal.add(request.url());
      request.abort("blockedbyclient");
    }
  });

  await page.evaluateOnNewDocument(() => {
    const diagnostics = {
      rafScheduled: 0,
      rafExecuted: 0,
      rafSites: {},
      observers: {},
      resizeCallbacks: 0,
      longTasks: 0,
      longTaskDuration: 0,
    };
    Object.defineProperty(window, "__sentiqRuntimeDiagnostics", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: diagnostics,
    });

    const callSite = () => {
      const stack = String(new Error().stack || "").split("\n").slice(2, 5).join(" | ");
      return stack || "unknown";
    };

    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      diagnostics.rafScheduled += 1;
      const site = callSite();
      diagnostics.rafSites[site] = (diagnostics.rafSites[site] || 0) + 1;
      return nativeRequestAnimationFrame((timestamp) => {
        diagnostics.rafExecuted += 1;
        callback(timestamp);
      });
    };

    const NativeMutationObserver = window.MutationObserver;
    let observerId = 0;
    window.MutationObserver = class InstrumentedMutationObserver extends NativeMutationObserver {
      constructor(callback) {
        const id = String(++observerId);
        diagnostics.observers[id] = { callbacks: 0, records: 0, stack: callSite() };
        super((records, observer) => {
          diagnostics.observers[id].callbacks += 1;
          diagnostics.observers[id].records += records.length;
          return callback(records, observer);
        });
      }
    };

    const NativeResizeObserver = window.ResizeObserver;
    if (typeof NativeResizeObserver === "function") {
      window.ResizeObserver = class InstrumentedResizeObserver extends NativeResizeObserver {
        constructor(callback) {
          super((entries, observer) => {
            diagnostics.resizeCallbacks += 1;
            return callback(entries, observer);
          });
        }
      };
    }

    if (typeof PerformanceObserver === "function") {
      try {
        const longTaskObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            diagnostics.longTasks += 1;
            diagnostics.longTaskDuration += entry.duration;
          });
        });
        longTaskObserver.observe({ type: "longtask", buffered: true });
      } catch {
        // Long-task reporting is optional in headless Chromium.
      }
    }
  });

  const cdp = await page.createCDPSession();
  await cdp.send("Performance.enable");

  const navigationStartedAt = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  const domContentLoadedMs = Date.now() - navigationStartedAt;
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 10_000 });
  await sleep(2_000);

  const beforeDiagnostics = await page.evaluate(() => structuredClone(window.__sentiqRuntimeDiagnostics));
  const beforeMetrics = await cdp.send("Performance.getMetrics");
  const beforeFrameState = await page.evaluate(() => window.SentIQFrameDiscipline?.getState?.() || null);

  await sleep(2_000);

  const afterDiagnostics = await page.evaluate(() => structuredClone(window.__sentiqRuntimeDiagnostics));
  const afterMetrics = await cdp.send("Performance.getMetrics");
  const afterFrameState = await page.evaluate(() => window.SentIQFrameDiscipline?.getState?.() || null);

  const taskDuration = metricValue(afterMetrics, "TaskDuration") - metricValue(beforeMetrics, "TaskDuration");
  const scriptDuration = metricValue(afterMetrics, "ScriptDuration") - metricValue(beforeMetrics, "ScriptDuration");
  const rafExecuted = delta(afterDiagnostics, beforeDiagnostics, "rafExecuted");
  const mutationRecords = Object.values(afterDiagnostics.observers || {}).reduce((sum, observer) => sum + Number(observer.records || 0), 0)
    - Object.values(beforeDiagnostics.observers || {}).reduce((sum, observer) => sum + Number(observer.records || 0), 0);
  const observerActivity = summarizeObservers(afterDiagnostics.observers, beforeDiagnostics.observers);

  const interactionBefore = await page.evaluate(() => ({
    plusExpanded: document.getElementById("composer-plus-btn")?.getAttribute("aria-expanded") || "",
    modeExpanded: document.getElementById("execution-mode-toggle")?.getAttribute("aria-expanded") || "",
    modeDisabled: document.getElementById("execution-mode-toggle")?.disabled
      || document.getElementById("execution-mode-toggle")?.getAttribute("aria-disabled") === "true",
  }));
  await page.click("#composer-plus-btn");
  await sleep(80);
  const plusExpanded = await page.$eval("#composer-plus-btn", (element) => element.getAttribute("aria-expanded") || "");
  await page.click("#composer-plus-btn");
  await sleep(40);

  // 1. Guest mode execution-mode toggle interaction
  await page.click("#execution-mode-toggle");
  await sleep(80);
  const guestModeExpanded = await page.$eval("#execution-mode-toggle", (element) => element.getAttribute("aria-expanded") || "");

  // 2. Authenticated mode execution-mode toggle interaction
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("sentiq-auth-changed", {
      detail: { session: { user: { id: "smoke-test-user" } } },
    }));
  });
  await sleep(80);
  const authModeBefore = await page.$eval("#execution-mode-toggle", (element) => element.getAttribute("aria-expanded") || "");
  const authModeDisabled = await page.$eval("#execution-mode-toggle", (element) => element.disabled
    || element.getAttribute("aria-disabled") === "true");
  await page.click("#execution-mode-toggle");
  await sleep(80);
  const authModeOpened = await page.$eval("#execution-mode-toggle", (element) => element.getAttribute("aria-expanded") || "");
  await page.click("#execution-mode-toggle");
  await sleep(40);
  const authModeClosed = await page.$eval("#execution-mode-toggle", (element) => element.getAttribute("aria-expanded") || "");
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("sentiq-auth-changed", { detail: { session: null } }));
  });

  const interaction = await page.evaluate(() => ({
    plusPresent: Boolean(document.getElementById("composer-plus-btn")),
    modePresent: Boolean(document.getElementById("execution-mode-toggle")),
    title: document.title,
    readyState: document.readyState,
    bodyTextLength: document.body?.innerText?.length || 0,
    mobileNavigationState: document.getElementById("sidebar")?.dataset.mobileNavigationState || "",
  }));
  interaction.plusBefore = interactionBefore.plusExpanded;
  interaction.plusExpanded = plusExpanded;
  interaction.modeBefore = interactionBefore.modeExpanded;
  interaction.modeExpanded = guestModeExpanded;
  interaction.guestModeExpanded = guestModeExpanded;
  interaction.authModeOpened = authModeOpened;
  interaction.authModeClosed = authModeClosed;

  const report = {
    url,
    domContentLoadedMs,
    interaction,
    idleWindowSeconds: 2,
    taskDurationSeconds: Number(taskDuration.toFixed(4)),
    scriptDurationSeconds: Number(scriptDuration.toFixed(4)),
    rafExecuted,
    mutationRecords,
    resizeCallbacks: delta(afterDiagnostics, beforeDiagnostics, "resizeCallbacks"),
    longTasks: delta(afterDiagnostics, beforeDiagnostics, "longTasks"),
    longTaskDurationMs: Number(delta(afterDiagnostics, beforeDiagnostics, "longTaskDuration").toFixed(2)),
    frameFlushDelta: Number(afterFrameState?.flushCount || 0) - Number(beforeFrameState?.flushCount || 0),
    frameState: afterFrameState,
    observerActivity,
    blockedExternal: [...blockedExternal],
    consoleErrors,
    pageErrors,
  };
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (interaction.readyState !== "complete") failures.push(`document.readyState=${interaction.readyState}`);
  if (!interaction.plusPresent || !interaction.modePresent) failures.push("core composer controls are missing");
  if (interaction.plusExpanded === interaction.plusBefore) failures.push("composer action control did not change state when clicked");
  if (interactionBefore.modeDisabled !== true || guestModeExpanded !== "false") {
    failures.push("guest execution-mode toggle did not enforce disabled Fast-only contract");
  }
  if (authModeDisabled !== false || authModeOpened === authModeBefore || authModeOpened !== "true" || authModeClosed !== "false") {
    failures.push("authenticated execution-mode control did not change state when clicked");
  }
  if (interaction.mobileNavigationState !== "desktop") failures.push(`desktop mobile-navigation state was ${interaction.mobileNavigationState || "missing"}`);
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);
  if (domContentLoadedMs > 8_000) failures.push(`DOMContentLoaded took ${domContentLoadedMs}ms`);
  if (taskDuration > 0.8) failures.push(`idle TaskDuration was ${taskDuration.toFixed(3)}s over a 2s window`);
  if (scriptDuration > 0.65) failures.push(`idle ScriptDuration was ${scriptDuration.toFixed(3)}s over a 2s window`);
  if (rafExecuted > 180) failures.push(`${rafExecuted} requestAnimationFrame callbacks executed while idle`);
  if (mutationRecords > 500) failures.push(`${mutationRecords} mutation records were processed while idle`);
  if (Number(afterFrameState?.flushCount || 0) - Number(beforeFrameState?.flushCount || 0) > 120) {
    failures.push("frame coordinator continued flushing excessively while idle");
  }
  if (failures.length) throw new Error(`Frontend runtime smoke failed:\n- ${failures.join("\n- ")}`);

  console.log("Frontend runtime smoke passed: startup completed, controls responded, and the idle main thread remained bounded.");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
