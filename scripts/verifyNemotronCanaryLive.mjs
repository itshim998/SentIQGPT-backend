import {
  projectCanaryUsage,
  summarizeCanarySse,
  validateCanarySse,
  validateCanaryUsage,
  validateCanaryUsageDelta,
} from "./nemotronCanaryContract.mjs";

const confirmation = String(process.env.SENTIQ_LIVE_VERIFY_CONFIRM_CANARY || "").trim().toLowerCase();
const canaryLabelRaw = String(process.env.SENTIQ_LIVE_VERIFY_CANARY_LABEL || "").trim();
const baseUrlRaw = String(process.env.SENTIQ_LIVE_VERIFY_BASE_URL || "").trim();
const accessToken = String(process.env.SENTIQ_LIVE_VERIFY_ACCESS_TOKEN || "").trim();
const anonymousId = String(process.env.SENTIQ_LIVE_VERIFY_ANONYMOUS_ID || "").trim()
  || `nemotron-canary-${Date.now().toString(36)}`;
const requireWebSurf = String(process.env.SENTIQ_LIVE_VERIFY_REQUIRE_WEBSURF || "true").trim().toLowerCase() !== "false";
const requestTimeoutMs = Math.max(
  30_000,
  Math.min(150_000, Number.parseInt(process.env.SENTIQ_LIVE_VERIFY_REQUEST_TIMEOUT_MS || "135000", 10) || 135_000),
);
const MAX_CANCELLATION_OBSERVED_BYTES = 512 * 1024;

function resolveCanaryLabel() {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(canaryLabelRaw)) {
    throw new Error("SENTIQ_LIVE_VERIFY_CANARY_LABEL must be a non-secret 3–80 character canary label.");
  }
  return canaryLabelRaw;
}

function resolveBaseUrl() {
  if (confirmation !== "true") {
    throw new Error("Live verification requires SENTIQ_LIVE_VERIFY_CONFIRM_CANARY=true.");
  }
  if (!baseUrlRaw) throw new Error("SENTIQ_LIVE_VERIFY_BASE_URL is required.");
  const parsed = new URL(baseUrlRaw);
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !local) {
    throw new Error("Remote canary verification requires an HTTPS base URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The canary base URL must not contain credentials.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

const canaryLabel = resolveCanaryLabel();
const baseUrl = resolveBaseUrl();
const headers = {
  "Content-Type": "application/json",
  "X-SentIQ-Anonymous-Id": anonymousId,
  ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
};

function safeLog(value) {
  console.log(JSON.stringify(value));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("canary request timeout")), requestTimeoutMs);
  const parentSignal = options.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function waitForReady() {
  let lastStatus = null;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/ready`, { headers });
      lastStatus = response.status;
      if (response.ok) {
        safeLog({ scenario: "readiness", status: "pass", http_status: response.status, attempts: attempt });
        return;
      }
    } catch {
      lastStatus = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Canary did not become ready; last status ${lastStatus ?? "unavailable"}.`);
}

async function readUsage() {
  const response = await fetchWithTimeout(`${baseUrl}/api/billing/usage`, {
    method: "GET",
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  return { ...payload, __http_status: response.status };
}

async function runChatScenario(name, body, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("canary stream timeout")), requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...body,
        client_request_id: `${name}-${Date.now().toString(36)}`,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const summary = summarizeCanarySse(raw, response.status);
    const validation = validateCanarySse(summary, options);
    const result = {
      scenario: name,
      status: validation.valid ? "pass" : "fail",
      ...summary,
      issues: validation.issues,
    };
    safeLog(result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyCancellation() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("canary cancellation timeout")), requestTimeoutMs);
  let reader = null;
  try {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: "Give a concise three-item checklist for reviewing a small code change.",
        execution_mode: "intuitive",
        client_request_id: `cancel-${Date.now().toString(36)}`,
        context: { recent_messages: [], memories: [], file_references: [], image_attachments: [] },
      }),
      signal: controller.signal,
    });
    reader = response.body?.getReader();
    if (!reader) throw new Error("Cancellation scenario did not receive a readable stream.");
    const decoder = new TextDecoder();
    let observed = "";
    let visibleStarted = false;
    let aborted = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        observed += decoder.decode(value, { stream: true });
        if (observed.length > MAX_CANCELLATION_OBSERVED_BYTES) {
          throw new Error("Cancellation scenario exceeded the safe observation limit before visible output.");
        }
        if (/"type"\s*:\s*"token"/.test(observed)) {
          visibleStarted = true;
          controller.abort();
          aborted = true;
          break;
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
      aborted = true;
    }
    const summary = summarizeCanarySse(observed, response.status);
    const valid = response.status === 200
      && visibleStarted
      && aborted
      && !summary.forbiddenPublicMarker;
    const result = {
      scenario: "intuitive_cancellation",
      status: valid ? "pass" : "fail",
      httpStatus: response.status,
      visibleStarted,
      aborted,
      forbiddenPublicMarker: summary.forbiddenPublicMarker,
    };
    safeLog(result);
    return result;
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* abort may already close the stream */ }
  }
}

async function waitForSettlement(maxAttempts = 15) {
  let latest = await readUsage();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const projected = projectCanaryUsage(latest);
    if (projected.reservedTokens === 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    latest = await readUsage();
  }
  return latest;
}

async function main() {
  safeLog({ scenario: "canary_metadata", label: canaryLabel });
  await waitForReady();

  const beforePayload = await readUsage();
  const beforeValidation = validateCanaryUsage(beforePayload);
  safeLog({
    scenario: "unified_text_preflight",
    status: beforeValidation.valid ? "pass" : "fail",
    usage: beforeValidation.usage,
    issues: beforeValidation.issues,
  });
  if (!beforeValidation.valid) throw new Error("Canary unified-token preflight failed.");
  if (beforeValidation.usage.exhausted || beforeValidation.usage.fastAvailableTokens < 8_000) {
    throw new Error("Canary identity needs at least 8,000 Fast-available tokens for the verification suite.");
  }
  if (!beforeValidation.usage.intuitiveAllowed || beforeValidation.usage.intuitiveAvailableTokens < 6_000) {
    throw new Error("Canary identity needs at least 6,000 Intuitive-available tokens for the verification suite.");
  }

  const results = [];
  results.push(await runChatScenario("fast_ordinary", {
    message: "Reply with one short acknowledgement.",
    execution_mode: "fast",
    context: { recent_messages: [], memories: [], file_references: [], image_attachments: [] },
  }, { requireRouteEvent: true }));

  results.push(await runChatScenario("intuitive_ordinary", {
    message: "Reply with one short acknowledgement.",
    execution_mode: "intuitive",
    context: { recent_messages: [], memories: [], file_references: [], image_attachments: [] },
  }, { requireRouteEvent: true }));

  results.push(await runChatScenario("intuitive_file_context", {
    message: "State the control value in the attached note in one sentence.",
    execution_mode: "intuitive",
    context: {
      recent_messages: [],
      memories: [],
      file_references: [{
        filename: "verification-note.txt",
        extractedText: "The synthetic control value is cobalt.",
        mime_type: "text/plain",
      }],
      image_attachments: [],
    },
  }, { requireRouteEvent: true }));

  if (requireWebSurf) {
    results.push(await runChatScenario("intuitive_websurf", {
      message: "In one sentence, identify the current Node.js LTS release line.",
      execution_mode: "intuitive",
      context: {
        recent_messages: [],
        memories: [],
        file_references: [],
        image_attachments: [],
        web_search_mode: "basic",
      },
    }, { requireRouteEvent: true, requireWebSurfSources: true }));
  }

  const cancellation = await verifyCancellation();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const afterPayload = await waitForSettlement();
  const afterValidation = validateCanaryUsage(afterPayload);
  const delta = validateCanaryUsageDelta(beforePayload, afterPayload);
  safeLog({
    scenario: "unified_text_settlement",
    status: afterValidation.valid && delta.valid ? "pass" : "fail",
    usage: afterValidation.usage,
    issues: [...afterValidation.issues, ...delta.issues],
  });

  const failures = results.filter((result) => result.status !== "pass").length
    + Number(cancellation.status !== "pass")
    + Number(!afterValidation.valid || !delta.valid);
  safeLog({
    scenario: "summary",
    status: failures === 0 ? "pass" : "fail",
    failures,
    websurf_required: requireWebSurf,
  });
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  safeLog({
    scenario: "fatal",
    status: "fail",
    error_class: error?.name || "Error",
    message: error instanceof Error ? error.message : "Live canary verification could not complete.",
  });
  process.exitCode = 1;
});
