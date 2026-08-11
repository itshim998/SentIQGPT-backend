import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";

class FakeClassList {
  #values = new Set();

  add(...names) { names.forEach((name) => this.#values.add(name)); }
  remove(...names) { names.forEach((name) => this.#values.delete(name)); }
  toggle(name, force) {
    const next = force === undefined ? !this.#values.has(name) : Boolean(force);
    if (next) this.#values.add(name);
    else this.#values.delete(name);
    return next;
  }
  contains(name) { return this.#values.has(name); }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.dataset = {};
    this.style = { display: "" };
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.subtitle = { textContent: "" };
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === ".composer-action-subtitle" ? this.subtitle : null; }
  querySelectorAll() { return []; }
  appendChild() {}
}

const actions = new Map([
  "file-attach-btn",
  "websurf-basic-btn",
  "image-gen-btn",
  "deep-research-btn",
].map((id) => [id, new FakeElement(id)]));
const listeners = new Map();
const document = {
  readyState: "complete",
  head: new FakeElement("head"),
  body: new FakeElement("body"),
  createElement: () => new FakeElement(),
  getElementById: (id) => actions.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(type, listener) {
    const current = listeners.get(type) || [];
    current.push(listener);
    listeners.set(type, current);
  },
};
const window = {
  document,
  SentIQAuth: { getSession: async () => null },
  addEventListener: () => undefined,
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  requestAnimationFrame: (callback) => { callback(); return 1; },
};

const source = await readFile(new URL("../scripts/features/guest-experience.js", import.meta.url), "utf8");
const context = createContext({
  console,
  document,
  window,
  Element: FakeElement,
  Node: FakeElement,
  MutationObserver: class { disconnect() {} observe() {} },
  Promise,
  queueMicrotask,
});
new Script(source, { filename: "guest-experience.js" }).runInContext(context);
await new Promise((resolve) => setImmediate(resolve));

for (const button of actions.values()) {
  assert.equal(button.disabled, true, `${button.id} must be disabled while the session is unknown`);
  assert.equal(button.classList.contains("auth-disabled"), true);
  assert.equal(button.dataset.guestAuthRequired, "true");
}

for (const listener of listeners.get("sentiq-auth-changed") || []) {
  listener({ detail: { session: { user: { id: "authenticated-user" } } } });
}

for (const button of actions.values()) {
  assert.equal(button.disabled, false, `${button.id} must be re-enabled after authentication`);
  assert.equal(button.getAttribute("aria-disabled"), "false");
  assert.equal(button.classList.contains("auth-disabled"), false);
  assert.equal(button.classList.contains("guest-auth-required"), false);
  assert.equal(button.dataset.guestAuthRequired, undefined);
}

console.log("Guest auth-release behavior passed: authenticated WebSurf and Deep Research controls do not retain guest disabled state.");
