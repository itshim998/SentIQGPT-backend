import assert from "node:assert/strict";

class FakeHTMLElement {
  constructor() {
    this.dataset = {};
  }

  removeAttribute(name) {
    const datasetKey = String(name)
      .replace(/^data-/, "")
      .replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    delete this.dataset[datasetKey];
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

const reducedMotionMedia = createMediaQuery(false);
const slowUpdateMedia = createMediaQuery(false);
const dispatchedEvents = [];
const root = new FakeHTMLElement();

globalThis.HTMLElement = FakeHTMLElement;
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
  matchMedia(query) {
    return query.includes("prefers-reduced-motion") ? reducedMotionMedia : slowUpdateMedia;
  },
};

await import("../scripts/features/motion-grammar.js");

assert.equal(root.dataset.sentiqMotionVersion, "11.1");
assert.equal(root.dataset.sentiqMotionPolicy, "full");
assert.equal(window.SentIQMotionGrammar.version, "11.1");
assert.deepEqual(window.SentIQMotionGrammar.families, [
  "surface",
  "layout",
  "focus",
  "progress",
  "completion",
  "interrupt",
]);
assert.equal(window.SentIQMotionGrammar.getPolicy(), "full");

const surface = new FakeHTMLElement();
assert.equal(window.SentIQMotionGrammar.mark(surface, "surface", { phase: "exit" }), true);
assert.equal(surface.dataset.sentiqMotionFamily, "surface");
assert.equal(surface.dataset.sentiqMotionPhase, "exit");
assert.equal(window.SentIQMotionGrammar.clear(surface), true);
assert.equal(surface.dataset.sentiqMotionFamily, undefined);
assert.equal(surface.dataset.sentiqMotionPhase, undefined);
assert.equal(window.SentIQMotionGrammar.mark(surface, "bounce"), false);

const policies = [];
const unsubscribe = window.SentIQMotionGrammar.subscribe((detail) => policies.push(detail.policy));
assert.deepEqual(policies, ["full"]);

reducedMotionMedia.setMatches(true);
assert.equal(window.SentIQMotionGrammar.getPolicy(), "reduced");
assert.equal(root.dataset.sentiqMotionPolicy, "reduced");
assert.deepEqual(policies, ["full", "reduced"]);
assert.equal(dispatchedEvents.at(-1)?.type, "sentiq-motion-policy-change");

reducedMotionMedia.setMatches(false);
slowUpdateMedia.setMatches(true);
assert.equal(window.SentIQMotionGrammar.getPolicy(), "reduced");

slowUpdateMedia.setMatches(false);
assert.equal(window.SentIQMotionGrammar.getPolicy(), "full");
unsubscribe();

console.log("Pass 11.1 motion grammar runtime gate passed.");
