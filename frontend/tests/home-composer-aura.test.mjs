import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scriptSource = await readFile(
  new URL("../scripts/features/home-position-composer.js", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../styles/modules/22-home-position-composer.css", import.meta.url),
  "utf8",
);
const visibilitySource = await readFile(
  new URL("../styles/modules/81-home-composer-aura-visibility.css", import.meta.url),
  "utf8",
);
const compositionSource = await readFile(
  new URL("../styles/modules/82-home-composer-composition.css", import.meta.url),
  "utf8",
);
const importSource = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);

for (const token of [
  'const AURA_ATTRIBUTE = "data-home-composer-aura"',
  "function setHomeComposerAuraState(state)",
  "function cancelAuraReveal()",
  "function scheduleAuraReveal()",
  "AURA_STATE.entering",
  "AURA_STATE.settled",
  "AURA_STATE.hidden",
  'attributeFilter: ["class"]',
]) {
  assert.ok(scriptSource.includes(token), `Home composer aura lifecycle missing ${token}`);
}

assert.ok(
  scriptSource.includes("auraFrame = window.requestAnimationFrame(() =>"),
  "Aura reveal must wait for a painted empty-chat layout",
);
assert.ok(
  scriptSource.includes("window.cancelAnimationFrame(auraFrame)"),
  "Aura reveal must be cancellable when the first message leaves the empty state",
);
assert.equal(
  scriptSource.includes("setInterval("),
  false,
  "Home composer aura must not introduce a perpetual timer",
);
assert.equal(
  scriptSource.includes('attributeFilter: ["class", "data-home-composer-aura"]'),
  false,
  "Aura state writes must not feed back into the layout observer",
);

for (const token of [
  "--sentiq-home-composer-shell-width: 780px",
  "width: min(var(--sentiq-home-composer-shell-width), calc(100% - 48px))",
  "max-width: min(var(--sentiq-home-composer-shell-width), calc(100% - 48px))",
  '[data-home-composer-aura="entering"]',
  '[data-home-composer-aura="settled"]',
  "@media (prefers-reduced-motion: reduce)",
  "@media (forced-colors: active)",
]) {
  assert.ok(styleSource.includes(token), `Focused home composer styling missing ${token}`);
}

const visibilityImport = '@import url("./81-home-composer-aura-visibility.css")';
const compositionImport = '@import url("./82-home-composer-composition.css")';
assert.ok(importSource.includes(visibilityImport), "The visible wrapper-level aura must remain loaded");
assert.ok(importSource.includes(compositionImport), "The final home composition polish must be loaded");
assert.ok(
  importSource.indexOf(compositionImport) > importSource.indexOf(visibilityImport),
  "The centred composition must load after the earlier aura visibility correction",
);

for (const token of [
  ".main-content > .chat-input-wrapper::after",
  'data-home-composer-aura="entering"',
  'data-home-composer-aura="settled"',
  ".chat-input-area:not(.is-response-locked)::before",
]) {
  assert.ok(visibilitySource.includes(token), `Visible home composer aura missing ${token}`);
}

const tokensSource = await readFile(
  new URL("../styles/modules/01-tokens-base.css", import.meta.url),
  "utf8",
);

for (const token of [
  "--sentiq-home-top-space: minmax(72px, 0.82fr)",
  "--sentiq-home-bottom-space: minmax(64px, 1fr)",
  "width: min(var(--sentiq-home-composer-shell-width), calc(100% - 48px))",
  "padding-top: 18px",
  "isolation: isolate",
  "top: 50%",
  "left: 50%",
  "width: calc(100% + 180px)",
  "height: calc(100% + 120px)",
  "z-index: 0",
  "ellipse at 50% 50%",
  "transform: translate3d(-50%, -50%, 0)",
  ".main-content.is-empty-chat .main-content-glow::before",
  "top: 58%",
  "opacity: 0.82",
]) {
  assert.ok(compositionSource.includes(token), `Gemini-style centered composer aura missing ${token}`);
}

assert.ok(
  tokensSource.includes("ellipse at 50% 58%"),
  "Canvas home glow token must be centered at 58% behind the composer",
);

assert.equal(
  compositionSource.includes("top: calc(50% + 92px)"),
  false,
  "The former offset desktop aura position must not return",
);
assert.equal(
  compositionSource.includes("ellipse at 50% 106%"),
  false,
  "The former bottom-weighted gradient must not return",
);
assert.equal(
  compositionSource.includes("filter: blur("),
  false,
  "The final aura must use bounded gradients rather than another blur layer",
);
assert.equal(
  `${styleSource}\n${visibilitySource}\n${compositionSource}`.includes("animation-iteration-count: infinite"),
  false,
  "Home composer aura must settle rather than pulse indefinitely",
);
assert.equal(
  styleSource.includes("radial-gradient(ellipse at 50% 32%"),
  false,
  "The retired full-width under-composer wash must not return",
);

console.log("Home composer aura gate passed: the welcome and composer geometry stay fixed while the purple halo is centered directly behind the message composer capsule (Gemini style).");
