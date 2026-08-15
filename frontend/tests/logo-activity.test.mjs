import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeSource = await readFile(
  new URL("../scripts/features/logo-activity.js", import.meta.url),
  "utf8",
);
const cssSource = await readFile(
  new URL("../styles/modules/91-logo-activity.css", import.meta.url),
  "utf8",
);
const domRefsSource = await readFile(
  new URL("../scripts/features/chat/dom-refs.js", import.meta.url),
  "utf8",
);

for (const token of [
  'customElements.define("sentiq-activity-logo"',
  '"neural-dialog"',
  '"neural-orbit"',
  '"infinite-dialog"',
  'state === "loading"',
  'state === "reading-files"',
  '"Thinking"',
  'assets/sentiqlogo-neural-dialog.svg',
  'assets/sentiqlogo-neural-orbit.svg',
  'assets/sentiqlogo-infinite-dialog.svg',
  '91-logo-activity.css',
]) {
  assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);
}

for (const token of [
  ".sentiq-activity-logo__geometry",
  ".sentiq-activity-logo__breath",
  ".sentiq-activity-logo__shimmer",
  "-webkit-mask-image: var(--sentiq-activity-logo-asset)",
  "mask-image: var(--sentiq-activity-logo-asset)",
  "@keyframes sentiqActivityLogoBreathe",
  "@keyframes sentiqActivityLogoShimmer",
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) {
  assert.ok(cssSource.includes(token), `Logo animation CSS missing ${token}`);
}

assert.ok(
  domRefsSource.includes('import "../logo-activity.js";'),
  "The chat runtime must load the reusable activity logo primitive",
);

console.log("SentIQ activity logo contract gate passed.");
