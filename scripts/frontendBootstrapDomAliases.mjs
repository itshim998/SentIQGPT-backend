/* Test-only DOM constructor aliases for the frontend bootstrap harness. */

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
  "HTMLTextAreaElement",
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

if (!("SVGElement" in globalThis)) {
  Object.defineProperty(globalThis, "SVGElement", {
    configurable: true,
    enumerable: false,
    get() {
      return globalThis.Element || globalThis.HTMLElement || class BootstrapSVGElement {};
    },
  });
}
