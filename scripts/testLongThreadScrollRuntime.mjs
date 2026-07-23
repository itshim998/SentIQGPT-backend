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
  throw new Error("No Chrome or Chromium executable was found for the long-thread scroll runtime test.");
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

const server = createStaticServer();
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, HOST, resolvePromise);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const localOrigin = `http://${HOST}:${port}`;
const url = `${localOrigin}/index.html?long-thread-scroll-runtime=1`;

let browser;
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

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(15_000);
  page.setDefaultTimeout(10_000);
  await page.setViewport({ width: 1680, height: 940, deviceScaleFactor: 1 });

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(localOrigin)) request.continue();
    else request.abort("blockedbyclient");
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 10_000 });
  await sleep(1200);

  await page.evaluate(() => {
    const chatMessages = document.getElementById("chat-messages");
    const mainContent = document.querySelector(".main-content");
    const welcome = document.getElementById("welcome-screen");
    if (!(chatMessages instanceof HTMLElement)) throw new Error("#chat-messages is missing");

    welcome?.setAttribute("hidden", "");
    mainContent?.classList.remove("is-empty-chat");
    chatMessages.classList.add("has-messages");
    chatMessages.replaceChildren();

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 72; index += 1) {
      const message = document.createElement("article");
      const assistant = index % 2 === 1;
      message.className = `message ${assistant ? "assistant" : "user"}`;
      message.dataset.requestId = `scroll-runtime-${index}`;
      const content = document.createElement("div");
      content.className = "message-content";
      const paragraphCount = assistant ? 5 : 2;
      for (let paragraph = 0; paragraph < paragraphCount; paragraph += 1) {
        const node = document.createElement("p");
        node.textContent = `Long conversation message ${index + 1}, paragraph ${paragraph + 1}. `
          + "This deliberately repeated content creates a production-sized reading surface so delayed scroll restoration, virtualisation, and anchoring all run during the test. ".repeat(assistant ? 4 : 2);
        content.appendChild(node);
      }
      message.appendChild(content);
      fragment.appendChild(message);
    }
    chatMessages.appendChild(fragment);
  });

  await sleep(1600);

  const geometry = await page.evaluate(() => {
    const scroller = document.getElementById("chat-messages");
    if (!(scroller instanceof HTMLElement)) throw new Error("#chat-messages is missing");
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.floor(maximum * 0.45);
    scroller.dispatchEvent(new Event("scroll"));
    const rect = scroller.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      maximum,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    };
  });

  await sleep(500);
  const before = await page.$eval("#chat-messages", (scroller) => scroller.scrollTop);
  await page.mouse.move(geometry.x, geometry.y);
  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel({ deltaY: 280 });
    await sleep(70);
  }
  const immediate = await page.$eval("#chat-messages", (scroller) => scroller.scrollTop);

  await page.evaluate((restoreTarget) => {
    window.setTimeout(() => {
      const scroller = document.getElementById("chat-messages");
      if (!(scroller instanceof HTMLElement)) return;
      document.documentElement.dataset.scrollRuntimeDelayedWrite = "attempted";
      scroller.scrollTop = restoreTarget;
    }, 620);
  }, before);

  await sleep(1400);
  const settled = await page.$eval("#chat-messages", (scroller) => scroller.scrollTop);

  const runtimeState = await page.evaluate(() => ({
    frame: window.SentIQFrameDiscipline?.getState?.() || null,
    guard: window.SentIQScrollInteractionGuard?.getState?.() || null,
    longConversation: window.SentIQLongConversation?.getState?.() || null,
    conversationId: window.SentIQConversationContinuity?.getConversationId?.() || "",
    manualDataset: document.documentElement.dataset.sentiqManualScroll || "",
    correctionDataset: document.documentElement.dataset.sentiqScrollCorrection || "",
    delayedWrite: document.documentElement.dataset.scrollRuntimeDelayedWrite || "",
    windowed: document.getElementById("chat-messages")?.dataset.longConversationWindowed || "",
  }));

  const immediateDelta = immediate - before;
  const settledDelta = settled - before;
  const rebound = immediate - settled;
  const report = {
    url,
    geometry,
    before,
    immediate,
    settled,
    immediateDelta,
    settledDelta,
    rebound,
    runtimeState,
    pageErrors,
  };
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);
  if (geometry.maximum < 3000) failures.push(`long-thread fixture was not scrollable enough: maximum=${geometry.maximum}`);
  if (immediateDelta < 180) failures.push(`wheel input moved only ${immediateDelta}px immediately`);
  if (settledDelta < 180) failures.push(`wheel position retained only ${settledDelta}px after a delayed direct scroll write`);
  if (rebound > 120) failures.push(`scroll position rebounded ${rebound}px after wheel input`);
  if (failures.length) throw new Error(`Long-thread scroll runtime failed:\n- ${failures.join("\n- ")}`);

  console.log("Long-thread scroll runtime passed: wheel input remained authoritative even when a delayed runtime attempted to restore the old scrollTop.");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
