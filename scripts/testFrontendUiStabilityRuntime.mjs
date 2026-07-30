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
    const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
    const nextFrame = () => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    const root = document.documentElement;
    const app = document.querySelector(".app-container");
    const input = document.getElementById("chat-input");
    const composer = document.querySelector(".chat-input-area");
    const plus = document.getElementById("composer-plus-btn");
    const send = document.getElementById("send-btn");
    const messages = document.getElementById("chat-messages");
    const chatList = document.getElementById("chat-list");
    const newChat = document.getElementById("new-chat-btn");

    const samples = [];
    for (let index = 0; index < 14; index += 1) {
      await nextFrame();
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
    const visualState = {
      bootState: root.dataset.sentiqBootState || "",
      startupScreenPresent: Boolean(document.getElementById("sentiq-startup-screen")),
      appVisibility: appStyle.visibility,
      appOpacity: Number(appStyle.opacity),
      inputMaxHeight: Number.parseFloat(inputStyle.maxHeight),
      inputFieldSizing: inputStyle.fieldSizing || "fixed",
      messageTextWrap: contentStyle.textWrap || "wrap",
      streamAnimationName: lineStyle.animationName || "none",
    };
    probeMessage.remove();

    function appendUserMessage(text) {
      const message = document.createElement("div");
      message.className = "message user";
      const content = document.createElement("div");
      content.className = "message-content";
      content.textContent = text;
      message.appendChild(content);
      messages.appendChild(message);
      return message;
    }

    function appendAssistantMessage(text, failed = false) {
      const message = document.createElement("div");
      message.className = "message assistant";
      const content = document.createElement("div");
      content.className = "message-content";
      if (failed) {
        const errorWrap = document.createElement("div");
        errorWrap.className = "message-error-wrap";
        errorWrap.textContent = text;
        content.appendChild(errorWrap);
      } else {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        content.appendChild(paragraph);
      }
      message.appendChild(content);
      messages.appendChild(message);
      return message;
    }

    const blockControllerClick = (event) => {
      if (event.target instanceof Element && event.target.closest("#send-btn")) event.stopImmediatePropagation();
    };
    document.addEventListener("click", blockControllerClick, true);

    const fastPrompt = "Have you heard about Montek LC?";
    input.value = fastPrompt;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    send.disabled = false;
    send.setAttribute("aria-disabled", "false");
    send.classList.remove("is-stop");
    send.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    send.classList.add("is-stop");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    appendUserMessage(fastPrompt);
    await wait(60);
    appendAssistantMessage("Yes. This is a successful Fast-mode response.");
    input.value = fastPrompt;
    send.classList.remove("is-stop");
    await wait(120);
    const fastSuccessfulDraftCleared = input.value === "";

    const failedPrompt = "Preserve this retry draft";
    input.value = failedPrompt;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    send.classList.remove("is-stop");
    send.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    send.classList.add("is-stop");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    appendUserMessage(failedPrompt);
    await wait(60);
    appendAssistantMessage("Request failed", true);
    input.value = failedPrompt;
    send.classList.remove("is-stop");
    await wait(120);
    const failedDraftPreserved = input.value === failedPrompt;
    document.removeEventListener("click", blockControllerClick, true);

    function createHistoryItem(index) {
      const item = document.createElement("div");
      item.className = "chat-list-item";
      item.dataset.id = `runtime-chat-${index}`;
      const title = document.createElement("span");
      title.className = "chat-list-item-title";
      title.textContent = `Runtime conversation ${index}`;
      item.appendChild(title);
      return item;
    }

    const originalListStyle = chatList.getAttribute("style") || "";
    chatList.style.height = "260px";
    chatList.style.overflowY = "auto";
    chatList.replaceChildren(...Array.from({ length: 14 }, (_, index) => createHistoryItem(index)));
    chatList.scrollTop = 70;
    await nextFrame();
    const initialHistoryHeight = chatList.getBoundingClientRect().height;
    const initialHistoryScroll = chatList.scrollTop;

    newChat.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    await nextFrame();
    const historySamples = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const label = document.createElement("div");
      label.className = "chat-history-group-label";
      label.textContent = pass === 0 ? "Today" : pass === 1 ? "Yesterday" : "Previous 7 days";
      const items = Array.from({ length: 8 + pass }, (_, index) => createHistoryItem(pass * 20 + index));
      chatList.replaceChildren(label, ...items);
      chatList.scrollTop = initialHistoryScroll;
      await wait(45);
      const item = chatList.querySelector(".chat-list-item");
      const renderedLabel = chatList.querySelector(".chat-history-group-label") || label;
      const itemStyle = getComputedStyle(item);
      const labelStyle = renderedLabel.isConnected ? getComputedStyle(renderedLabel) : null;
      historySamples.push({
        active: chatList.classList.contains("sentiq-chat-list-stabilizing"),
        height: chatList.getBoundingClientRect().height,
        itemTransitionDuration: itemStyle.transitionDuration,
        itemAnimationName: itemStyle.animationName,
        labelTransitionDuration: labelStyle?.transitionDuration || "0s",
        labelAnimationName: labelStyle?.animationName || "none",
      });
    }
    await wait(1_350);
    const historySettled = !chatList.classList.contains("sentiq-chat-list-stabilizing")
      && root.dataset.sentiqChatListStability === "settled";
    const historyScrollRestored = Math.abs(chatList.scrollTop - initialHistoryScroll) <= 1;
    chatList.setAttribute("style", originalListStyle);

    return {
      ...visualState,
      samples,
      fastSuccessfulDraftCleared,
      failedDraftPreserved,
      initialHistoryHeight,
      historySamples,
      historySettled,
      historyScrollRestored,
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
  if (!report.fastSuccessfulDraftCleared) failures.push("successful Fast-mode prompt was restored into the composer");
  if (!report.failedDraftPreserved) failures.push("failed-send retry draft was cleared");
  if (report.initialHistoryHeight <= 0) failures.push("chat-list stability probe had no measurable height");
  if (!report.historySamples.every((sample) => sample.active)) failures.push("chat-list stabilisation ended during the mutation burst");
  if (!report.historySamples.every((sample) => sample.itemTransitionDuration === "0s" && sample.labelTransitionDuration === "0s")) {
    failures.push("chat-list items or group labels retained transitions during new-chat refresh");
  }
  if (!report.historySamples.every((sample) => sample.itemAnimationName === "none" && sample.labelAnimationName === "none")) {
    failures.push("chat-list items or group labels retained animations during new-chat refresh");
  }
  if (!report.historySettled) failures.push("chat-list stabilisation did not settle within its bounded window");
  if (!report.historyScrollRestored) failures.push("chat-list scroll position was not restored after new-chat refresh");
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);

  console.log(JSON.stringify({ ...report, pageErrors }, null, 2));
  if (failures.length) throw new Error(`Frontend UI stability smoke failed:\n- ${failures.join("\n- ")}`);
  console.log("Frontend UI stability smoke passed: startup revealed once, multiline composer geometry stayed fixed, successful Fast drafts cleared while failed drafts remained recoverable, new-chat history refreshes stayed motionless, and streaming text did not reanimate.");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
