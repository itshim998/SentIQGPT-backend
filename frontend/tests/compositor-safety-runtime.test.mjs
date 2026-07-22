import assert from "node:assert/strict";

class FakeStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value) {
    this.values.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.values.get(name) || "";
  }
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

function createMediaQuery(initialMatches = false) {
  const listeners = new Set();
  return {
    matches: initialMatches,
    addEventListener(type, listener) {
      if (type === "change") listeners.add(listener);
    },
    setMatches(matches) {
      this.matches = Boolean(matches);
      listeners.forEach((listener) => listener({ matches: this.matches }));
    },
  };
}

function createConnection(initialSaveData = false) {
  const listeners = new Set();
  return {
    saveData: initialSaveData,
    addEventListener(type, listener) {
      if (type === "change") listeners.add(listener);
    },
    setSaveData(saveData) {
      this.saveData = Boolean(saveData);
      listeners.forEach((listener) => listener({ saveData: this.saveData }));
    },
  };
}

const reducedMotionMedia = createMediaQuery(false);
const slowUpdateMedia = createMediaQuery(false);
const connection = createConnection(false);
const root = { dataset: {} };
const dispatchedEvents = [];

globalThis.CustomEvent = FakeCustomEvent;
globalThis.document = {
  readyState: "complete",
  documentElement: root,
  addEventListener() {},
  dispatchEvent(event) {
    dispatchedEvents.push(event);
    return true;
  },
};
globalThis.window = {
  navigator: { connection },
  matchMedia(query) {
    return query.includes("prefers-reduced-motion") ? reducedMotionMedia : slowUpdateMedia;
  },
};

await import("../scripts/features/compositor-safety.js");

assert.equal(root.dataset.sentiqCompositorVersion, "11.2");
assert.equal(root.dataset.sentiqCompositorPolicy, "full");
assert.equal(window.SentIQCompositorSafety.version, "11.2");
assert.deepEqual(window.SentIQCompositorSafety.properties, ["transform", "opacity"]);
assert.equal(window.SentIQCompositorSafety.getPolicy(), "full");
assert.deepEqual(window.SentIQCompositorSafety.normalizeProperties("width, opacity, transform"), ["opacity", "transform"]);
assert.equal(window.SentIQCompositorSafety.progressScale(65), 0.65);

const progressElement = { style: new FakeStyle() };
assert.equal(window.SentIQCompositorSafety.setProgress(progressElement, 125), true);
assert.equal(progressElement.style.getPropertyValue("--sentiq-progress-scale"), "1");
assert.equal(window.SentIQCompositorSafety.setProgress({}, 50), false);

const policies = [];
const unsubscribe = window.SentIQCompositorSafety.subscribe((detail) => policies.push(detail.policy));
assert.deepEqual(policies, ["full"]);

reducedMotionMedia.setMatches(true);
assert.equal(window.SentIQCompositorSafety.getPolicy(), "reduced");
assert.equal(root.dataset.sentiqCompositorPolicy, "reduced");
assert.deepEqual(policies, ["full", "reduced"]);
assert.equal(dispatchedEvents.at(-1)?.type, "sentiq-compositor-policy-change");

reducedMotionMedia.setMatches(false);
slowUpdateMedia.setMatches(true);
assert.equal(window.SentIQCompositorSafety.getPolicy(), "reduced");

slowUpdateMedia.setMatches(false);
connection.setSaveData(true);
assert.equal(window.SentIQCompositorSafety.getPolicy(), "reduced");

connection.setSaveData(false);
assert.equal(window.SentIQCompositorSafety.getPolicy(), "full");
unsubscribe();

console.log("Pass 11.2 compositor runtime gate passed.");
