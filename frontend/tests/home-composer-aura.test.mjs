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

assert.ok(
  importSource.includes('@import url("./81-home-composer-aura-visibility.css")'),
  "The visibility correction must load after the established compositor and accessibility layers",
);

for (const token of [
  ".main-content > .chat-input-wrapper::after",
  "top: calc(50% + 4px)",
  "width: calc(100% + 168px)",
  "height: calc(100% + 72px)",
  "border-radius: 999px",
  "z-index: -1",
  "opacity: 0.74",
  'data-home-composer-aura="entering"',
  'data-home-composer-aura="settled"',
  ".chat-input-area:not(.is-response-locked)::before",
]) {
  assert.ok(visibilitySource.includes(token), `Composer-contained home aura missing ${token}`);
}

assert.equal(
  visibilitySource.includes("height: calc(100% + 150px)"),
  false,
  "The oversized vertical aura that overlapped the welcome heading must not return",
);
assert.equal(
  visibilitySource.includes("filter: blur("),
  false,
  "The visibility fix must use a bounded radial field rather than adding another blur layer",
);
assert.equal(
  `${styleSource}\n${visibilitySource}`.includes("animation-iteration-count: infinite"),
  false,
  "Home composer aura must settle rather than pulse indefinitely",
);
assert.equal(
  styleSource.includes("radial-gradient(ellipse at 50% 32%"),
  false,
  "The retired full-width under-composer wash must not return",
);

console.log("Home composer aura gate passed: the purple field stays centred on the composer, avoids the welcome heading, remains cancellable, and is motion-safe.");
