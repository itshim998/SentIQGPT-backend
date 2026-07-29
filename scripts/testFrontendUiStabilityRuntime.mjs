import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendRoot = resolve(repositoryRoot, "frontend");
const HOST = "127.0.0.1";
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function findChromeExecutable() {
  const configured = String(process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  const candidates = [
    configured,
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
      // Try the next browser binary.
    }
  }
  throw new Error("No Chrome or Chromium executable was found for the UI stability smoke test.");
}

function safeFilePath(requestUrl = "/") {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(frontendRoot, normalize(relative));
  return candidate === frontendRoot || candidate.startsWith(`${frontendRoot}/`) ? candidate : null;
}

const server = createServer((request, response) => {
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

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, HOST, resolvePromise);
});

const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const localOrigin = `http://${HOST}:${port}`;
let browser;

try {
  browser = await puppeteer.launch({
    executablePath: findChromeExecutable(),
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--no-first-run"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10_000);

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(localOrigin)) request.continue();
    else request.abort("blockedbyclient");
  });

  await page.goto(`${localOrigin}/index.html?ui-stability-smoke=1`, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForFunction(() => document.documentElement.dataset.sentiqBootState === "ready");

  await page.evaluate(() => {
    const input = document.getElementById("chat-input");
    input.value = Array.from({ length: 12 }, (_, index) => (
      `Line ${index + 1}: a deliberately long composer sentence that verifies stable wrapping without height oscillation.`
    )).join("\n");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));

  const report = await page.evaluate(async () => {
    const root = document.documentElement;
    const app = document.querySelector(".app-container");
    const input = document.getElementById("chat-input");
    const composer = document.querySelector(".chat-input-area");
    const plus = document.getElementById("composer-plus-btn");
    const messages = document.getElementById("chat-messages");

    const samples = [];
    for (let index = 0; index < 14; index += 1) {
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const inputRect = input.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const plusRect = plus.getBoundingClientRect();
      samples.push({
        inputHeight: inputRect.height,
        composerHeight: composerRect.height,
        plusBottomClearance: composerRect.bottom - plusRect.bottom,
      });
    }

    const probeMessage = document.createElement("div");
    probeMessage.className = "message assistant";
    const probeContent = document.createElement("div");
    probeContent.className = "message-content";
    const streaming = document.createElement("div");
    streaming.className = "streaming-rendered streaming-render-pulse";
    const finalLine = document.createElement("p");
    finalLine.textContent = "A streaming line must remain stationary.";
    streaming.appendChild(finalLine);
    probeContent.appendChild(streaming);
    probeMessage.appendChild(probeContent);
    messages.appendChild(probeMessage);

    const appStyle = getComputedStyle(app);
    const inputStyle = getComputedStyle(input);
    const contentStyle = getComputedStyle(probeContent);
    const lineStyle = getComputedStyle(finalLine);
    const startupScreenPresent = Boolean(document.getElementById("sentiq-startup-screen"));
    probeMessage.remove();

    return {
      bootState: root.dataset.sentiqBootState || "",
      startupScreenPresent,
      appVisibility: appStyle.visibility,
      appOpacity: Number(appStyle.opacity),
      inputMaxHeight: Number.parseFloat(inputStyle.maxHeight),
      inputFieldSizing: inputStyle.fieldSizing || "fixed",
      messageTextWrap: contentStyle.textWrap || "wrap",
      streamAnimationName: lineStyle.animationName,
      samples,
    };
  });

  const inputHeights = report.samples.map((sample) => sample.inputHeight);
  const composerHeights = report.samples.map((sample) => sample.composerHeight);
  const clearances = report.samples.map((sample) => sample.plusBottomClearance);
  const spread = (values) => Math.max(...values) - Math.min(...values);
  const failures = [];

  if (report.bootState !== "ready") failures.push(`boot state was ${report.bootState || "missing"}`);
  if (report.startupScreenPresent) failures.push("startup screen remained after readiness");
  if (report.appVisibility !== "visible" || report.appOpacity < 0.99) failures.push("application shell was not fully visible after readiness");
  if (spread(inputHeights) > 1) failures.push(`textarea height oscillated by ${spread(inputHeights).toFixed(2)}px`);
  if (spread(composerHeights) > 1) failures.push(`composer height oscillated by ${spread(composerHeights).toFixed(2)}px`);
  if (Math.min(...clearances) < 8) failures.push(`plus control bottom clearance fell to ${Math.min(...clearances).toFixed(2)}px`);
  if (Math.max(...inputHeights) > 150.5) failures.push(`textarea exceeded the 150px desktop cap (${Math.max(...inputHeights).toFixed(2)}px)`);
  if (report.messageTextWrap !== "wrap") failures.push(`message text-wrap was ${report.messageTextWrap}`);
  if (report.streamAnimationName !== "none") failures.push(`streaming final-line animation was ${report.streamAnimationName}`);
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);

  console.log(JSON.stringify({ ...report, pageErrors }, null, 2));
  if (failures.length) throw new Error(`Frontend UI stability smoke failed:\n- ${failures.join("\n- ")}`);
  console.log("Frontend UI stability smoke passed: startup revealed once, multiline composer geometry stayed fixed, controls retained safe spacing, and streaming text did not reanimate.");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
