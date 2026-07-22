import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const markerPath = resolve("frontend/deployment-revision.json");
const expected = JSON.parse(readFileSync(markerPath, "utf8"));
const baseUrl = String(
  process.env.SENTIQ_FRONTEND_DEPLOYMENT_URL
  || "https://ui-sentiq-liquid-glass-v4.sentiqgpt-frontend.pages.dev/",
).replace(/\/+$/, "");
const attempts = Math.max(1, Number(process.env.SENTIQ_DEPLOYMENT_VERIFY_ATTEMPTS || 60));
const delayMs = Math.max(500, Number(process.env.SENTIQ_DEPLOYMENT_VERIFY_DELAY_MS || 10_000));

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function matches(actual) {
  return actual
    && actual.token === expected.token
    && actual.contentRevision === expected.contentRevision
    && actual.pass === expected.pass;
}

let lastResult = "No response received";
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const markerUrl = `${baseUrl}/deployment-revision.json?token=${encodeURIComponent(expected.token)}&attempt=${attempt}&ts=${Date.now()}`;
  try {
    const response = await fetch(markerUrl, {
      cache: "no-store",
      headers: {
        "cache-control": "no-cache, no-store, must-revalidate",
        pragma: "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    lastResult = `HTTP ${response.status}: ${body.slice(0, 500)}`;
    if (response.ok) {
      const actual = JSON.parse(body);
      if (matches(actual)) {
        console.log(`Verified deployed frontend revision on attempt ${attempt}: ${expected.token}`);
        console.log(JSON.stringify({ baseUrl, expected, actual }, null, 2));
        process.exit(0);
      }
    }
  } catch (error) {
    lastResult = error instanceof Error ? error.message : String(error);
  }

  console.log(`Deployment marker not current yet (${attempt}/${attempts}): ${lastResult}`);
  if (attempt < attempts) await sleep(delayMs);
}

throw new Error(`Pages deployment did not expose the expected revision marker ${expected.token}. Last result: ${lastResult}`);
