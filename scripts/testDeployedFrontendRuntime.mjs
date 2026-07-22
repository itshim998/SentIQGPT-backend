import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const baseUrl = String(
  process.env.SENTIQ_FRONTEND_DEPLOYMENT_URL
  || "https://ui-sentiq-liquid-glass-v4.sentiqgpt-frontend.pages.dev/",
).replace(/\/+$/, "");
const url = `${baseUrl}/?deployed-runtime-smoke=${Date.now()}`;

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function findChromeExecutable() {
  const configured = String(process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  for (const candidate of [
    configured,
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
  throw new Error("No Chrome or Chromium executable was found for the deployed frontend smoke test.");
}

function metricValue(metrics, name) {
  return metrics.metrics.find((metric) => metric.name === name)?.value || 0;
}

let browser;
let page;
try {
  browser = await puppeteer.launch({
    executablePath: findChromeExecutable(),
    headless: true,
    protocolTimeout: 20_000,
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

  page = await browser.newPage();
  page.setDefaultNavigationTimeout(20_000);
  page.setDefaultTimeout(10_000);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const navigationStartedAt = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const domContentLoadedMs = Date.now() - navigationStartedAt;
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 12_000 });
  await page.waitForSelector("#composer-plus-btn", { visible: true });
  await page.waitForSelector("#execution-mode-toggle", { visible: true });
  await sleep(1_500);

  const cdp = await page.createCDPSession();
  await cdp.send("Performance.enable");
  const beforeMetrics = await cdp.send("Performance.getMetrics");
  await sleep(2_000);
  const afterMetrics = await cdp.send("Performance.getMetrics");
  const taskDuration = metricValue(afterMetrics, "TaskDuration") - metricValue(beforeMetrics, "TaskDuration");
  const scriptDuration = metricValue(afterMetrics, "ScriptDuration") - metricValue(beforeMetrics, "ScriptDuration");

  const before = await page.evaluate(() => ({
    plusExpanded: document.getElementById("composer-plus-btn")?.getAttribute("aria-expanded") || "",
    modeExpanded: document.getElementById("execution-mode-toggle")?.getAttribute("aria-expanded") || "",
  }));
  await page.click("#composer-plus-btn");
  await sleep(100);
  const plusExpanded = await page.$eval("#composer-plus-btn", (element) => element.getAttribute("aria-expanded") || "");
  await page.click("#composer-plus-btn");
  await sleep(60);
  await page.click("#execution-mode-toggle");
  await sleep(100);
  const modeExpanded = await page.$eval("#execution-mode-toggle", (element) => element.getAttribute("aria-expanded") || "");

  const state = await page.evaluate(() => ({
    readyState: document.readyState,
    title: document.title,
    bodyTextLength: document.body?.innerText?.length || 0,
    mobileNavigationState: document.getElementById("sidebar")?.dataset.mobileNavigationState || "",
    capabilityVersion: document.documentElement.dataset.capabilityAwarenessVersion || "",
  }));

  const report = {
    url,
    domContentLoadedMs,
    taskDurationSeconds: Number(taskDuration.toFixed(4)),
    scriptDurationSeconds: Number(scriptDuration.toFixed(4)),
    interaction: {
      plusBefore: before.plusExpanded,
      plusExpanded,
      modeBefore: before.modeExpanded,
      modeExpanded,
    },
    state,
    pageErrors,
    consoleErrors: consoleErrors.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (state.readyState !== "complete") failures.push(`document.readyState=${state.readyState}`);
  if (state.bodyTextLength < 100) failures.push("deployed page body did not render meaningful content");
  if (state.mobileNavigationState !== "desktop") failures.push(`desktop mobile-navigation state was ${state.mobileNavigationState || "missing"}`);
  if (!state.capabilityVersion) failures.push("capability-awareness runtime did not initialize");
  if (plusExpanded === before.plusExpanded) failures.push("composer action control did not change state when clicked");
  if (modeExpanded === before.modeExpanded) failures.push("execution-mode control did not change state when clicked");
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);
  if (domContentLoadedMs > 10_000) failures.push(`DOMContentLoaded took ${domContentLoadedMs}ms`);
  if (taskDuration > 1.2) failures.push(`idle TaskDuration was ${taskDuration.toFixed(3)}s over a 2s window`);
  if (scriptDuration > 1.0) failures.push(`idle ScriptDuration was ${scriptDuration.toFixed(3)}s over a 2s window`);

  if (failures.length) {
    await page.screenshot({ path: "frontend-live-runtime-failure.png", fullPage: true }).catch(() => {});
    throw new Error(`Deployed frontend runtime smoke failed:\n- ${failures.join("\n- ")}`);
  }

  console.log("Deployed frontend runtime smoke passed: the Pages build loaded, became interactive, and remained responsive while idle.");
} finally {
  await browser?.close().catch(() => {});
}
