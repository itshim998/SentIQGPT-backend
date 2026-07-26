const baseUrl = process.env.SENTIQ_LIVE_VERIFY_BASE_URL || "http://127.0.0.1:3331";
const anonymousId = process.env.SENTIQ_LIVE_VERIFY_ANONYMOUS_ID
  || `nemotron-live-${Date.now().toString(36)}`;
const headers = {
  "Content-Type": "application/json",
  "X-SentIQ-Anonymous-Id": anonymousId,
};
const forbiddenProviderPattern = /\bnvidia\b|\bnemotron\b|integrate\.api\.nvidia\.com/i;
const hiddenReasoningPattern = /reasoning_content|<think>|<\/think>/i;

async function waitForHealth() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError || new Error("stack health timed out");
}

async function readSseScenario(name, body) {
  const response = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...body,
      client_request_id: `${name}-${Date.now().toString(36)}`,
    }),
  });
  const raw = await response.text();
  const dataLines = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  const events = dataLines
    .filter((line) => line && line !== "[DONE]")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const result = {
    scenario: name,
    http_status: response.status,
    token_events: events.filter((event) => event.type === "token").length,
    error_events: events.filter((event) => event.type === "error").length,
    done: dataLines.includes("[DONE]"),
    websurf_sources: events.some((event) => event.type === "websurf_sources"),
    structured_response: events.some((event) => event.type === "structured_response"),
    provider_branding_visible: forbiddenProviderPattern.test(raw),
    hidden_reasoning_visible: hiddenReasoningPattern.test(raw),
  };
  console.log(JSON.stringify(result));
  return result;
}

async function readUsage() {
  const response = await fetch(`${baseUrl}/api/billing/usage`, { headers });
  const payload = await response.json();
  const quotas = payload?.summary?.quotas ?? {};
  const project = (feature) => {
    const quota = quotas?.[feature] ?? {};
    return {
      used: Number.isFinite(quota.used) ? quota.used : null,
      reserved: Number.isFinite(quota.reserved) ? quota.reserved : null,
      remaining: Number.isFinite(quota.remaining) ? quota.remaining : null,
      tokens_consumed: Number.isFinite(quota.tokens_consumed) ? quota.tokens_consumed : null,
      tokens_remaining: Number.isFinite(quota.tokens_remaining) ? quota.tokens_remaining : null,
      policy_version: typeof quota.policy_version === "string" ? quota.policy_version : null,
    };
  };
  return {
    http_status: response.status,
    mode: payload?.mode ?? null,
    premium_text: project("premium_text"),
    lite_text: project("lite_text"),
  };
}

async function verifyCancellation() {
  const controller = new AbortController();
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
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let observed = "";
  let visibleStarted = false;
  let aborted = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      observed += decoder.decode(value, { stream: true });
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
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The abort may already have closed the stream.
    }
  }
  const result = {
    scenario: "intuitive_cancellation",
    http_status: response.status,
    visible_started: visibleStarted,
    aborted,
    provider_branding_visible: forbiddenProviderPattern.test(observed),
    hidden_reasoning_visible: hiddenReasoningPattern.test(observed),
  };
  console.log(JSON.stringify(result));
  return result;
}

async function main() {
  await waitForHealth();
  const before = await readUsage();
  const results = [];
  results.push(await readSseScenario("fast_ordinary", {
    message: "Reply with one short acknowledgement.",
    execution_mode: "fast",
    context: { recent_messages: [], memories: [], file_references: [], image_attachments: [] },
  }));
  results.push(await readSseScenario("intuitive_ordinary", {
    message: "Reply with one short acknowledgement.",
    execution_mode: "intuitive",
    context: { recent_messages: [], memories: [], file_references: [], image_attachments: [] },
  }));
  results.push(await readSseScenario("intuitive_file_context", {
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
  }));
  results.push(await readSseScenario("intuitive_websurf", {
    message: "In one sentence, identify the current Node.js LTS release line.",
    execution_mode: "intuitive",
    context: {
      recent_messages: [],
      memories: [],
      file_references: [],
      image_attachments: [],
      web_search_mode: "basic",
    },
  }));
  const cancellation = await verifyCancellation();
  // Let the server observe the closed client and settle/release its reservation
  // before the controlled before/after comparison.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const after = await readUsage();
  console.log(JSON.stringify({
    scenario: "billing_usage_delta",
    before,
    after,
    changed: JSON.stringify(before) !== JSON.stringify(after),
  }));

  const ordinaryPass = results
    .filter((result) => result.scenario !== "intuitive_websurf")
    .every((result) => (
      result.http_status === 200
      && result.token_events > 0
      && result.error_events === 0
      && result.done
      && !result.provider_branding_visible
      && !result.hidden_reasoning_visible
    ));
  const webPass = results
    .filter((result) => result.scenario === "intuitive_websurf")
    .every((result) => (
      result.http_status === 200
      && result.token_events > 0
      && result.error_events === 0
      && result.done
      && result.websurf_sources
      && !result.provider_branding_visible
      && !result.hidden_reasoning_visible
    ));
  const cancellationPass = cancellation.http_status === 200
    && cancellation.visible_started
    && cancellation.aborted
    && !cancellation.provider_branding_visible
    && !cancellation.hidden_reasoning_visible;
  const failures = Number(!ordinaryPass) + Number(!webPass) + Number(!cancellationPass);
  console.log(JSON.stringify({ scenario: "summary", failures }));
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(JSON.stringify({
    scenario: "fatal",
    error_class: error?.name || "Error",
    message: "Live stack verification could not complete.",
  }));
  process.exitCode = 1;
});
