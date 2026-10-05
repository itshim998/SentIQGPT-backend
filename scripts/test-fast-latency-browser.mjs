import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const calls = [];
const reports = [];
const listeners = new Map();

class FakeElement {
  closest(selector) {
    return selector === "#send-btn" ? this : null;
  }
}
class FakeTextArea extends FakeElement {}

globalThis.Element = FakeElement;
globalThis.HTMLTextAreaElement = FakeTextArea;
globalThis.window = globalThis;
globalThis.location = new URL("https://sentiqchat.sentiqlabs.com/");
globalThis.document = {
  visibilityState: "visible",
  addEventListener(type, callback) {
    listeners.set(type, callback);
  },
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    connection: { effectiveType: "4g", rtt: 50, saveData: false },
    sendBeacon(_url, blob) {
      blob.text().then((text) => reports.push(JSON.parse(text)));
      return true;
    },
  },
});
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
globalThis.SENTIQ_API_BASE = "https://api.example.test";
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: String(input), init });
  return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
};
globalThis.SentIQAPI = {
  async sendMessageStream(_message, _context, callbacks) {
    callbacks.onToken?.("Hello");
    callbacks.onDone?.();
    return { tokensReceived: true, interrupted: false, structured: false };
  },
};

await import(new URL("../frontend/scripts/observability/fast-latency.js", import.meta.url).href);

const traceId = "11111111-2222-4333-8444-555555555555";
listeners.get("click")?.({ target: new FakeElement() });
await window.fetch("https://api.example.test/api/chat/stream", {
  method: "POST",
  body: JSON.stringify({ execution_mode: "fast", client_request_id: traceId }),
});
assert(new URL(calls[0].url).searchParams.get("latency_trace_id") === traceId);

await window.SentIQAPI.sendMessageStream("hello", {
  executionMode: "fast",
  clientRequestId: traceId,
}, {});
await new Promise((resolve) => setTimeout(resolve, 30));

assert(reports.some((item) => item.report_type === "first_paint"));
assert(reports.some((item) => item.report_type === "terminal"));
assert(reports.every((item) => item.trace_id === traceId));
assert(reports.every((item) => !("message" in item) && !("prompt" in item)));

console.log("Fast latency browser observability test passed.");
process.exit(0);
