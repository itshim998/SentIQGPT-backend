import assert from "node:assert/strict";
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
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
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
      // Try the next executable.
    }
  }
  throw new Error("No Chrome or Chromium executable was found for the nested trust-panel runtime test.");
}

function safeFilePath(requestUrl = "/") {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(frontendRoot, normalize(relative));
  return candidate === frontendRoot || candidate.startsWith(`${frontendRoot}/`) ? candidate : null;
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

async function snapshot(page) {
  return page.evaluate(() => {
    const trust = document.getElementById("trust-modal");
    const settings = document.getElementById("settings-modal");
    const activeTab = trust?.querySelector(".trust-tab.active")?.dataset.trustTab || "";
    const activePanel = trust?.querySelector(".trust-tab-content.active")?.id || "";
    return {
      activeAdaptivePanel: window.SentIQPanels?.getActive?.() || "",
      trustDisplay: trust ? window.getComputedStyle(trust).display : "missing",
      trustAriaHidden: trust?.getAttribute("aria-hidden") || "",
      trustInert: Boolean(trust?.inert || trust?.hasAttribute("inert")),
      trustOpen: Boolean(window.SentIQPanels?.isOpen?.("trust-modal")),
      settingsDisplay: settings ? window.getComputedStyle(settings).display : "missing",
      settingsAriaHidden: settings?.getAttribute("aria-hidden") || "",
      settingsInert: Boolean(settings?.inert || settings?.hasAttribute("inert")),
      settingsOpen: Boolean(window.SentIQPanels?.isOpen?.("settings-modal")),
      activeTab,
      activePanel,
    };
  });
}

const server = createStaticServer();
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, HOST, resolvePromise);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const localOrigin = `http://${HOST}:${port}`;
const url = `${localOrigin}/index.html?nested-trust-runtime=1`;

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: findChromeExecutable(),
    headless: true,
    protocolTimeout: 30_000,
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

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(localOrigin)) request.continue();
    else request.abort("blockedbyclient");
  });

  console.log("nested-trust: loading frontend");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (
    typeof window.SentIQPanels?.isOpen === "function"
    && typeof window.SentIQTrustPanel?.open === "function"
  ));
  await sleep(120);

  console.log("nested-trust: opening Settings through its real observer lifecycle");
  await page.evaluate(() => {
    const settings = document.getElementById("settings-modal");
    settings.style.display = "flex";
    settings.setAttribute("aria-hidden", "false");
  });
  await page.waitForFunction(() => window.SentIQPanels?.isOpen?.("settings-modal") === true);

  const settingsOnly = await snapshot(page);
  assert.equal(settingsOnly.settingsOpen, true, "Settings must be registered as open before nesting Privacy & support");
  assert.equal(settingsOnly.settingsInert, false, "The active Settings panel must remain interactive");

  console.log("nested-trust: opening Privacy & support above Settings");
  await page.evaluate(() => window.SentIQTrustPanel.open("privacy"));
  await page.waitForFunction(() => window.SentIQPanels?.isOpen?.("trust-modal") === true);
  await sleep(120);

  const nestedOpen = await snapshot(page);
  assert.equal(nestedOpen.activeAdaptivePanel, "trust-modal", "Privacy & support must be the top adaptive panel");
  assert.equal(nestedOpen.trustOpen, true, "Privacy & support must remain registered as open");
  assert.equal(nestedOpen.trustAriaHidden, "false", "Privacy & support must remain exposed to accessibility APIs");
  assert.equal(nestedOpen.trustInert, false, "Privacy & support must not inherit stale inert state from Settings");
  assert.equal(nestedOpen.settingsInert, true, "Settings must be inert while Privacy & support is focused");

  for (const [tabName, panelId] of [
    ["terms", "trust-tab-terms"],
    ["controls", "trust-tab-controls"],
    ["support", "trust-tab-support"],
  ]) {
    console.log(`nested-trust: clicking ${tabName}`);
    await page.click(`#trust-modal .trust-tab[data-trust-tab='${tabName}']`);
    await sleep(60);
    const tabState = await snapshot(page);
    assert.equal(tabState.activeTab, tabName, `${tabName} tab must respond to a real pointer click`);
    assert.equal(tabState.activePanel, panelId, `${panelId} must become visible after its tab is clicked`);
  }

  console.log("nested-trust: closing with the X button");
  await page.click("#close-trust-btn");
  await page.waitForFunction(() => window.SentIQPanels?.isOpen?.("trust-modal") === false);
  const closedByButton = await snapshot(page);
  assert.equal(closedByButton.trustDisplay, "none", "The close button must hide Privacy & support");
  assert.equal(closedByButton.trustAriaHidden, "true", "The close button must mark Privacy & support hidden");
  assert.equal(closedByButton.trustOpen, false, "The close button must update adaptive panel state");
  assert.equal(closedByButton.activeAdaptivePanel, "settings-modal", "Settings must become the active panel again");
  assert.equal(closedByButton.settingsInert, false, "Settings must be interactive again after closing Privacy & support");

  console.log("nested-trust: reopening and closing with Escape");
  await page.evaluate(() => window.SentIQTrustPanel.open("privacy"));
  await page.waitForFunction(() => window.SentIQPanels?.isOpen?.("trust-modal") === true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.SentIQPanels?.isOpen?.("trust-modal") === false);
  const closedByEscape = await snapshot(page);
  assert.equal(closedByEscape.trustDisplay, "none", "Escape must hide Privacy & support");
  assert.equal(closedByEscape.trustOpen, false, "Escape must update adaptive panel state");
  assert.equal(closedByEscape.settingsInert, false, "Settings must be interactive after Escape closes the nested panel");

  assert.deepEqual(pageErrors, [], `Nested trust-panel runtime produced page errors: ${pageErrors.join("\n")}`);
  console.log(JSON.stringify({ settingsOnly, nestedOpen, closedByButton, closedByEscape }, null, 2));
  console.log("Nested Privacy & support runtime passed: tabs, close button, Escape, focus layering, and inert restoration all work above Settings.");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
