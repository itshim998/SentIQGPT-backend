/* Test-only DOM constructor and primitive aliases for the frontend bootstrap harness. */

const HTMLElementAliases = Object.freeze([
  "HTMLAnchorElement",
  "HTMLAudioElement",
  "HTMLButtonElement",
  "HTMLCanvasElement",
  "HTMLDetailsElement",
  "HTMLDialogElement",
  "HTMLDivElement",
  "HTMLFormElement",
  "HTMLImageElement",
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLLIElement",
  "HTMLMediaElement",
  "HTMLOptionElement",
  "HTMLSelectElement",
  "HTMLSpanElement",
  "HTMLTemplateElement",
  "HTMLTextAreaElement",
  "HTMLUListElement",
  "HTMLVideoElement",
]);

for (const constructorName of HTMLElementAliases) {
  if (constructorName in globalThis) continue;
  Object.defineProperty(globalThis, constructorName, {
    configurable: true,
    enumerable: false,
    get() {
      return globalThis.HTMLElement || globalThis.Element || class BootstrapHTMLElement {};
    },
  });
}

for (const constructorName of ["SVGElement", "DocumentFragment"]) {
  if (constructorName in globalThis) continue;
  Object.defineProperty(globalThis, constructorName, {
    configurable: true,
    enumerable: false,
    get() {
      return globalThis.Element || globalThis.HTMLElement || class BootstrapNode {};
    },
  });
}

function defineHarnessPrimitive(name, value) {
  if (name in Object.prototype) return;
  Object.defineProperty(Object.prototype, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}

function createHarnessNode(tagName = "") {
  const Constructor = globalThis.HTMLElement || globalThis.Element;
  const node = typeof Constructor === "function" ? new Constructor() : {};
  node.tagName = String(tagName || "").toUpperCase();
  return node;
}

// The legacy bootstrap harness uses lightweight object literals for document,
// elements, and CSSStyleDeclaration. These non-enumerable shims model only the
// standard primitives used by current frontend modules and never ship to users.
defineHarnessPrimitive("dispatchEvent", function dispatchEvent() {
  return true;
});
defineHarnessPrimitive("getPropertyValue", function getPropertyValue(name) {
  const value = this?.[name];
  return value === undefined || value === null ? "" : String(value);
});
defineHarnessPrimitive("hasAttribute", function hasAttribute(name) {
  return typeof this?.getAttribute === "function" && this.getAttribute(name) !== null;
});
defineHarnessPrimitive("toggleAttribute", function toggleAttribute(name, force) {
  const shouldHave = force === undefined ? !this.hasAttribute(name) : Boolean(force);
  if (shouldHave && typeof this?.setAttribute === "function") this.setAttribute(name, "");
  else if (!shouldHave && typeof this?.removeAttribute === "function") this.removeAttribute(name);
  return shouldHave;
});
defineHarnessPrimitive("getClientRects", function getClientRects() {
  if (typeof this?.getBoundingClientRect !== "function") return [];
  return [this.getBoundingClientRect()];
});
defineHarnessPrimitive("append", function append(...nodes) {
  nodes.forEach((node) => this?.appendChild?.(node));
});
defineHarnessPrimitive("before", function before(...nodes) {
  const parent = this?.parentElement;
  if (!parent || typeof parent.insertBefore !== "function") return;
  nodes.forEach((node) => parent.insertBefore(node, this));
});
defineHarnessPrimitive("after", function after(...nodes) {
  const parent = this?.parentElement;
  if (!parent || typeof parent.appendChild !== "function") return;
  nodes.forEach((node) => parent.appendChild(node));
});
defineHarnessPrimitive("replaceWith", function replaceWith(...nodes) {
  const parent = this?.parentElement;
  if (!parent) return;
  nodes.forEach((node) => parent.insertBefore?.(node, this));
  this.remove?.();
});
defineHarnessPrimitive("createComment", function createComment(text = "") {
  const node = createHarnessNode("#comment");
  node.nodeType = 8;
  node.textContent = String(text);
  return node;
});
defineHarnessPrimitive("createDocumentFragment", function createDocumentFragment() {
  const node = createHarnessNode("#document-fragment");
  node.nodeType = 11;
  return node;
});
defineHarnessPrimitive("createElementNS", function createElementNS(_namespace, tagName) {
  return createHarnessNode(tagName);
});
