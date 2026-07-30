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
  throw new Error("No Chrome or Chromium executable was found for the Priority polish smoke test.");
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
  page.setDefaultTimeout(12_000);

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(localOrigin)) request.continue();
    else request.abort("blockedbyclient");
  });

  await page.goto(`${localOrigin}/index.html?priority-polish-smoke=1`, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForFunction(() => document.documentElement.dataset.sentiqBootState === "ready");
  await page.waitForFunction(() => (
    window.SentIQStreamingPolish?.version === "12.8"
    && window.SentIQControlledResponsePolish?.version === "13.1"
    && window.SentIQLiveAudioVisualizer?.version === "13.2"
    && window.SentIQArtifactWorkspace?.version === "13.2"
  ));

  const report = await page.evaluate(async () => {
    const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
    const nextFrame = () => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    const messages = document.getElementById("chat-messages");
    const app = document.querySelector(".app-container");
    const livePanel = document.getElementById("live-beta-panel");
    const muteButton = document.getElementById("live-beta-mute");

    const assistant = document.createElement("div");
    assistant.className = "message assistant";
    const content = document.createElement("div");
    content.className = "message-content typing-active";
    content.dataset.sentiqStreamingPhase = "streaming";
    const rendered = document.createElement("div");
    rendered.className = "streaming-rendered";
    const firstBlock = document.createElement("p");
    firstBlock.textContent = "Priority layers should reveal this semantic block once.";
    rendered.appendChild(firstBlock);
    const tail = document.createElement("span");
    tail.className = "streaming-tail";
    tail.textContent = " active";
    content.append(rendered, tail);
    assistant.appendChild(content);
    messages.appendChild(assistant);

    await wait(45);
    const firstRevealStarted = firstBlock.classList.contains("sentiq-block-reveal");
    const caretStyle = getComputedStyle(tail, "::after");
    const caretActive = caretStyle.animationName.includes("sentiqStreamingCaretBreathe")
      && Number.parseFloat(caretStyle.opacity) > 0;
    const stableWrap = getComputedStyle(content).textWrap === "wrap";

    await wait(260);
    const firstRevealSettled = firstBlock.classList.contains("sentiq-block-settled")
      && !firstBlock.classList.contains("sentiq-block-reveal");
    const replacement = document.createElement("p");
    replacement.textContent = "The same logical block was replaced by the progressive renderer.";
    rendered.replaceChildren(replacement);
    await wait(55);
    const replacementDidNotReplay = replacement.classList.contains("sentiq-block-settled")
      && !replacement.classList.contains("sentiq-block-reveal");
    const replacementAnimation = getComputedStyle(replacement).animationName;

    livePanel.hidden = false;
    livePanel.setAttribute("aria-hidden", "false");
    livePanel.dataset.state = "listening";
    muteButton.setAttribute("aria-pressed", "false");
    document.dispatchEvent(new CustomEvent("sentiq-live-pcm-level", {
      detail: { direction: "input", level: 0.82, at: performance.now() },
    }));
    await wait(140);
    const listeningDirection = livePanel.dataset.liveAudioDirection;
    const listeningLevel = Number.parseFloat(getComputedStyle(livePanel).getPropertyValue("--live-audio-level")) || 0;
    const listeningOrbScale = Number.parseFloat(getComputedStyle(livePanel).getPropertyValue("--live-orb-scale")) || 1;
    const listeningWaveScale = Number.parseFloat(getComputedStyle(livePanel).getPropertyValue("--live-wave-scale-3")) || 0;

    livePanel.dataset.state = "speaking";
    document.dispatchEvent(new CustomEvent("sentiq-live-pcm-level", {
      detail: { direction: "output", level: 0.94, at: performance.now() },
    }));
    await wait(140);
    const speakingDirection = livePanel.dataset.liveAudioDirection;
    const speakingLevel = Number.parseFloat(getComputedStyle(livePanel).getPropertyValue("--live-audio-level")) || 0;

    livePanel.dataset.state = "muted";
    muteButton.setAttribute("aria-pressed", "true");
    await wait(70);
    const mutedDirection = livePanel.dataset.liveAudioDirection;
    const mutedLevel = Number.parseFloat(getComputedStyle(livePanel).getPropertyValue("--live-audio-level")) || 0;
    livePanel.hidden = true;
    livePanel.setAttribute("aria-hidden", "true");

    function createFileArtifact() {
      const panel = document.createElement("div");
      panel.className = "generated-file-panel format-html";
      const header = document.createElement("div");
      header.className = "generated-file-header";
      const titleWrap = document.createElement("div");
      titleWrap.className = "generated-file-title-wrap";
      const fileTitle = document.createElement("div");
      fileTitle.className = "generated-file-title";
      fileTitle.textContent = "Priority workspace.html";
      titleWrap.appendChild(fileTitle);
      const actions = document.createElement("div");
      actions.className = "generated-file-actions";
      const existingAction = document.createElement("button");
      existingAction.type = "button";
      existingAction.className = "generated-file-action";
      existingAction.textContent = "Preview";
      actions.appendChild(existingAction);
      header.append(titleWrap, actions);
      const body = document.createElement("div");
      body.className = "generated-file-body";
      const editor = document.createElement("textarea");
      editor.className = "generated-html-editor";
      editor.value = "persistent workspace state";
      body.appendChild(editor);
      panel.append(header, body);
      return { panel, editor };
    }

    const artifactHost = document.createElement("div");
    artifactHost.className = "message assistant";
    const artifactContent = document.createElement("div");
    artifactContent.className = "message-content";
    const { panel: filePanel, editor } = createFileArtifact();
    artifactContent.appendChild(filePanel);
    artifactHost.appendChild(artifactContent);
    messages.appendChild(artifactHost);
    await wait(100);

    const workspaceMediaMatches = matchMedia("(min-width: 1100px) and (min-height: 680px) and (hover: hover) and (pointer: fine)").matches;
    const fileExpand = filePanel.querySelector(".sentiq-artifact-expand");
    const fileExpandOffered = fileExpand instanceof HTMLButtonElement
      && !fileExpand.hidden
      && !fileExpand.disabled
      && getComputedStyle(fileExpand).display !== "none";
    const originalFileParent = filePanel.parentElement;
    fileExpand?.click();
    await nextFrame();
    await wait(40);

    const overlay = document.querySelector(".sentiq-artifact-workspace-overlay");
    const placeholder = document.querySelector(".sentiq-artifact-workspace-placeholder");
    const fileWorkspaceOpened = window.SentIQArtifactWorkspace.isOpen()
      && !overlay.hidden
      && filePanel.parentElement?.classList.contains("sentiq-artifact-workspace-content")
      && fileExpand.getAttribute("aria-expanded") === "true";
    const sameFileNodeMoved = overlay.contains(filePanel) && editor.value === "persistent workspace state";
    const backgroundInert = Boolean(app.inert) && app.getAttribute("aria-hidden") === "true";
    const placeholderReserved = placeholder instanceof HTMLElement
      && Number.parseFloat(getComputedStyle(placeholder).blockSize) > 0;
    const focusContained = document.activeElement?.classList.contains("sentiq-artifact-workspace-close") === true;

    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextFrame();
    await wait(40);
    const fileWorkspaceClosed = !window.SentIQArtifactWorkspace.isOpen()
      && overlay.hidden
      && filePanel.parentElement === originalFileParent
      && !document.querySelector(".sentiq-artifact-workspace-placeholder");
    const fileStatePreserved = editor.value === "persistent workspace state";
    const backgroundRestored = !app.inert && app.getAttribute("aria-hidden") !== "true";
    const focusRestored = document.activeElement === fileExpand;

    const chartHost = document.createElement("div");
    chartHost.className = "message assistant";
    const chartContent = document.createElement("div");
    chartContent.className = "message-content";
    const chart = document.createElement("div");
    chart.className = "message-chart-container is-ready";
    const chartHeader = document.createElement("header");
    chartHeader.className = "asset-result-header asset-chart-header";
    chartHeader.innerHTML = '<span class="asset-result-heading"><span class="asset-result-kicker">Chart</span><span class="asset-result-meta">Runtime probe</span></span><span class="asset-result-actions"></span>';
    const chartFrame = document.createElement("div");
    chartFrame.className = "message-chart-frame";
    const canvas = document.createElement("canvas");
    chartFrame.appendChild(canvas);
    chart.append(chartHeader, chartFrame);
    chartContent.appendChild(chart);
    chartHost.appendChild(chartContent);
    messages.appendChild(chartHost);
    await wait(100);
    const chartExpand = chart.querySelector(".sentiq-artifact-expand");
    const chartExpandOffered = chartExpand instanceof HTMLButtonElement
      && !chartExpand.hidden
      && !chartExpand.disabled;
    const originalChartParent = chart.parentElement;
    chartExpand?.click();
    await nextFrame();
    await wait(40);
    const chartWorkspaceOpened = window.SentIQArtifactWorkspace.isOpen()
      && overlay.contains(chart)
      && chart.parentElement?.classList.contains("sentiq-artifact-workspace-content");
    window.SentIQArtifactWorkspace.close();
    await nextFrame();
    await wait(40);
    const chartWorkspaceClosed = !window.SentIQArtifactWorkspace.isOpen()
      && chart.parentElement === originalChartParent
      && !document.body.classList.contains("sentiq-artifact-workspace-open");

    assistant.remove();
    artifactHost.remove();
    chartHost.remove();

    return {
      firstRevealStarted,
      firstRevealSettled,
      replacementDidNotReplay,
      replacementAnimation,
      caretActive,
      stableWrap,
      listeningDirection,
      listeningLevel,
      listeningOrbScale,
      listeningWaveScale,
      speakingDirection,
      speakingLevel,
      mutedDirection,
      mutedLevel,
      workspaceMediaMatches,
      fileExpandOffered,
      fileWorkspaceOpened,
      sameFileNodeMoved,
      backgroundInert,
      placeholderReserved,
      focusContained,
      fileWorkspaceClosed,
      fileStatePreserved,
      backgroundRestored,
      focusRestored,
      chartExpandOffered,
      chartWorkspaceOpened,
      chartWorkspaceClosed,
    };
  });

  const failures = [];
  if (!report.firstRevealStarted) failures.push("new semantic block did not begin its one-time opacity reveal");
  if (!report.firstRevealSettled) failures.push("semantic block reveal did not settle within the bounded window");
  if (!report.replacementDidNotReplay || report.replacementAnimation !== "none") failures.push("progressive replacement replayed block animation");
  if (!report.caretActive) failures.push("Priority 1 streaming caret was not active");
  if (!report.stableWrap) failures.push("UI stability wrapping was not authoritative");
  if (report.listeningDirection !== "input" || report.listeningLevel <= 0.05) failures.push("Live microphone amplitude did not drive the visualizer");
  if (report.listeningOrbScale <= 1 || report.listeningWaveScale <= 0.3) failures.push("Live orb or waveform did not react to microphone amplitude");
  if (report.speakingDirection !== "output" || report.speakingLevel <= 0.05) failures.push("Live model PCM did not drive the speaking visualizer");
  if (report.mutedDirection !== "idle" || report.mutedLevel > 0.001) failures.push("Live visualizer did not reset when muted");
  if (!report.workspaceMediaMatches) failures.push("Chromium did not expose the intended large-screen artifact media query");
  if (!report.fileExpandOffered || !report.chartExpandOffered) failures.push("large-screen artifact expansion was not offered for file and chart results");
  if (!report.fileWorkspaceOpened || !report.chartWorkspaceOpened) failures.push("expanded artifact workspace did not open for file and chart results");
  if (!report.sameFileNodeMoved || !report.fileStatePreserved) failures.push("artifact workspace did not preserve the live file node and editor state");
  if (!report.backgroundInert || !report.focusContained || !report.placeholderReserved) failures.push("artifact workspace accessibility or layout reservation failed");
  if (!report.fileWorkspaceClosed || !report.chartWorkspaceClosed) failures.push("artifact workspace did not restore file/chart surfaces");
  if (!report.backgroundRestored || !report.focusRestored) failures.push("artifact workspace did not restore background and focus state");
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);

  console.log(JSON.stringify({ ...report, pageErrors }, null, 2));
  if (failures.length) throw new Error(`Priority 1–3 Chromium regression smoke failed:\n- ${failures.join("\n- ")}`);
  console.log("Priority 1–3 Chromium regression smoke passed: stable streaming, one-time block reveal, PCM-reactive Live visuals, and state-preserving large-screen artifact expansion work together without uncaught errors.");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
