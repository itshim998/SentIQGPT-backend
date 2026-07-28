import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else if (this.values.has(value)) this.values.delete(value);
    else this.values.add(value);
    return this.values.has(value);
  }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.readOnly = false;
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.textContent = "";
    this.title = "";
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = true; return child; }
  querySelector(selector) { return selector === ".chat-input-area" ? composer : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest() { return null; }
  blur() {}
}

const wrapper = new FakeElement("wrapper");
const composer = new FakeElement("composer");
const input = new FakeElement("chat-input");
const filePreview = new FakeElement("file-preview-area");
filePreview.hidden = true;
const modeMenu = new FakeElement("execution-mode-menu");
const fastOption = new FakeElement("fast-option");
const intuitiveOption = new FakeElement("intuitive-option");
fastOption.dataset.executionMode = "fast";
intuitiveOption.dataset.executionMode = "intuitive";
intuitiveOption.classList.add("active");
fastOption.click = () => {
  fastOption.classList.add("active");
  intuitiveOption.classList.remove("active");
};
wrapper.appendChild(composer);

const documentListeners = new Map();
const windowListeners = new Map();
const addListener = (map, type, listener) => {
  if (!map.has(type)) map.set(type, []);
  map.get(type).push(listener);
};

const document = {
  readyState: "complete",
  visibilityState: "visible",
  querySelector(selector) {
    if (selector === ".chat-input-wrapper") return wrapper;
    if (selector === '[data-execution-mode="intuitive"].active') {
      return intuitiveOption.classList.contains("active") ? intuitiveOption : null;
    }
    if (selector === '[data-execution-mode="fast"]') return fastOption;
    if (selector === '[data-execution-mode="intuitive"]') return intuitiveOption;
    return null;
  },
  getElementById(id) {
    return { "chat-input": input, "file-preview-area": filePreview, "execution-mode-menu": modeMenu }[id] || null;
  },
  createElement() { return new FakeElement(); },
  addEventListener(type, listener) { addListener(documentListeners, type, listener); },
};

const recoveryAt = new Date(Date.now() + 30 * 60_000).toISOString();
const atReserve = {
  policy_version: "unified-text-tokens-v2",
  plan_code: "free",
  limit_tokens: 50_000,
  window_seconds: 18_000,
  used_tokens: 40_000,
  reserved_tokens: 0,
  remaining_tokens: 10_000,
  fast_reserve_tokens: 10_000,
  fast_available_tokens: 10_000,
  intuitive_available_tokens: 0,
  intuitive_allowed: false,
  required_mode: "fast",
  exhausted: false,
  next_recovery_at: recoveryAt,
  full_reset_at: recoveryAt,
};
let usagePayload = { quota_ui_enabled: true, summary: { text_allowance: atReserve } };
const streamCalls = [];
const messageCalls = [];
const externalErrors = [];

const API = {
  async getBillingUsage() { return usagePayload; },
  async sendMessageStream(_message, context, callbacks) {
    streamCalls.push(context.executionMode || context.execution_mode);
    if ((context.executionMode || context.execution_mode) === "intuitive") {
      const error = Object.assign(new Error("Fast required"), {
        code: "intuitive_fast_required",
        details: { ...atReserve, code: "intuitive_fast_required" },
      });
      callbacks?.onError?.(error, { partial: false });
      throw error;
    }
    return { response: "ok" };
  },
  async sendMessage(_message, context) {
    messageCalls.push(context.executionMode || context.execution_mode);
    const error = Object.assign(new Error("Exhausted"), {
      code: "unified_text_quota_exhausted",
      details: {
        ...atReserve,
        code: "unified_text_quota_exhausted",
        remaining_tokens: 0,
        fast_available_tokens: 0,
        exhausted: true,
      },
    });
    throw error;
  },
};

const window = {
  SentIQAPI: API,
  addEventListener(type, listener) { addListener(windowListeners, type, listener); },
  dispatchEvent(event) { (windowListeners.get(event.type) || []).forEach((listener) => listener(event)); },
  setInterval() { return 1; },
  clearInterval() {},
};

class FakeMutationObserver { observe() {} disconnect() {} }
class FakeCustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }

Object.assign(globalThis, {
  window,
  document,
  Element: FakeElement,
  MutationObserver: FakeMutationObserver,
  CustomEvent: FakeCustomEvent,
});

const controllerUrl = pathToFileURL(resolve("frontend/scripts/features/text-quota-controller.js"));
await import(`${controllerUrl.href}?runtime=${Date.now()}`);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

const result = await API.sendMessageStream("hello", { executionMode: "intuitive" }, {
  onError(error) { externalErrors.push(error); },
});
assert.equal(result.response, "ok");
assert.deepEqual(streamCalls, ["intuitive", "fast"]);
assert.equal(externalErrors.length, 0);
assert.equal(fastOption.classList.contains("active"), true);
assert.equal(intuitiveOption.classList.contains("active"), false);
assert.equal(window.SentIQTextQuota.getState().view.state, "fast-only");
assert.match(wrapper.children.at(-1)?.children?.[0]?.textContent || "", /Switched to Fast/);

usagePayload = {
  quota_ui_enabled: true,
  summary: {
    text_allowance: {
      ...atReserve,
      used_tokens: 50_000,
      remaining_tokens: 0,
      fast_available_tokens: 0,
      exhausted: true,
    },
  },
};
window.dispatchEvent(new FakeCustomEvent("sentiq-billing-summary", { detail: usagePayload }));
await assert.rejects(API.sendMessage("hello", { executionMode: "intuitive" }), /Exhausted/);
assert.deepEqual(messageCalls, ["intuitive"]);
assert.equal(input.readOnly, true);
assert.equal(composer.hasAttribute("inert"), true);
assert.equal(window.SentIQTextQuota.getState().view.state, "exhausted");

window.SentIQTextQuota.destroy();
console.log("Unified text quota controller runtime checks passed.");
