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
  ].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  for (const command of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    try {
      const candidate = execFileSync("which", [command], { encoding: "utf8" }).trim();
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // Continue through the known browser names.
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

function topCpuFunctions(profile, limit = 20) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const counts = new Map();
  for (const nodeId of profile.samples || []) counts.set(nodeId, (counts.get(nodeId) || 0) + 1);
  const total = Math.max(1, [...counts.values()].reduce((sum, count) => sum + count, 0));
  return [...counts.entries()]
    .map(([nodeId, samples]) => {
      const frame = nodes.get(nodeId)?.callFrame || {};
      return {
        samples,
        percent: Number(((samples / total) * 100).toFixed(2)),
        functionName: frame.functionName || "(anonymous)",
        url: frame.url || "",
        line: Number(frame.lineNumber ?? -1) + 1,
        column: Number(frame.columnNumber ?? -1) + 1,
      };
    })
    .sort((left, right) => right.samples - left.samples)
    .slice(0, limit);
}

const server = createServer((request, response) => {
  const path = fileFor(request.url);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": MIME[extname(path).toLowerCase()] || "application/octet-stream",
  });
  response.end(readFileSync(path));
});
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, HOST, resolvePromise);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const url = `http://${HOST}:${port}/index.html?startup-profile=1`;

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    protocolTimeout: 20_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const cdp = await page.createCDPSession();
  await cdp.send("Profiler.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.start");
  await cdp.send("Page.navigate", { url });
  await sleep(8_000);
  const { profile } = await cdp.send("Profiler.stop");
  const metrics = await cdp.send("Performance.getMetrics");
  const topFunctions = topCpuFunctions(profile);

  let rendererState = null;
  let rendererError = null;
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "({ readyState: document.readyState, title: document.title, bodyChildren: document.body?.children?.length || 0, frameState: window.SentIQFrameDiscipline?.getState?.() || null })",
      returnByValue: true,
    });
    rendererState = result.result?.value || null;
  } catch (error) {
    rendererError = error?.message || String(error);
  }

  const metric = (name) => metrics.metrics.find((item) => item.name === name)?.value || 0;
  const report = {
    url,
    rendererState,
    rendererError,
    taskDurationSeconds: Number(metric("TaskDuration").toFixed(3)),
    scriptDurationSeconds: Number(metric("ScriptDuration").toFixed(3)),
    layoutDurationSeconds: Number(metric("LayoutDuration").toFixed(3)),
    recalcStyleDurationSeconds: Number(metric("RecalcStyleDuration").toFixed(3)),
    topFunctions,
  };
  console.log(JSON.stringify(report, null, 2));

  if (rendererState?.readyState !== "complete") {
    throw new Error(`Frontend startup remained blocked after 8 seconds. Top CPU function: ${topFunctions[0]?.functionName || "unknown"} at ${topFunctions[0]?.url || "unknown"}:${topFunctions[0]?.line || 0}`);
  }
  console.log("Frontend startup profile passed: the document completed within the profiling window.");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
