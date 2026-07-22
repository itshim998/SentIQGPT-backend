import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const reducedEntry = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const motionGrammar = await readFile(new URL("../styles/modules/73-motion-grammar.css", import.meta.url), "utf8");
const refined = await readFile(new URL("../styles/modules/78-refined-reduced-motion.css", import.meta.url), "utf8");
const loaders = await readFile(new URL("../styles/modules/06-loaders.css", import.meta.url), "utf8");
const semanticProgress = await readFile(new URL("../styles/modules/42-semantic-activity-progress.css", import.meta.url), "utf8");
const liveWorkspace = await readFile(new URL("../styles/modules/51-live-workspace.css", import.meta.url), "utf8");

function balancedBraces(source) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && !quote && !inComment;
}

assert.ok(balancedBraces(refined), "Pass 11.7 CSS must have balanced blocks");
assert.ok(balancedBraces(motionGrammar), "Motion grammar must remain syntactically balanced");

assert.ok(reducedEntry.includes('@import url("./78-refined-reduced-motion.css");'));
assert.equal(reducedEntry.includes("0.01ms"), false, "Blanket 0.01ms fallback must be removed");
assert.equal(reducedEntry.includes("*, *::before, *::after"), false, "Entry layer must not target every element");
assert.equal(reducedEntry.includes("prefers-reduced-motion"), false, "Entry layer should only compose intentional policy modules");

assert.equal(motionGrammar.includes('data-sentiq-motion-policy="reduced"] *'), false,
  "Motion grammar must not retain a universal reduced-motion selector");
assert.equal(motionGrammar.includes("animation-duration: 1ms !important"), false,
  "Motion grammar must delegate reduced behaviour to Pass 11.7");
assert.ok(motionGrammar.includes("Pass 11.7 owns reduced and slow-update alternatives"));
assert.ok(motionGrammar.includes("--sentiq-motion-focus-duration: 80ms"));
assert.ok(motionGrammar.includes("--sentiq-motion-layout-duration: 0ms"));

for (const token of [
  "@media (prefers-reduced-motion: reduce), (update: slow)",
  "@keyframes sentiqReducedOpacityEnter",
  "@keyframes sentiqReducedOpacityExit",
  "scroll-behavior: auto !important",
  "body::before",
  "background-attachment: scroll !important",
  '[data-sentiq-motion-family="surface"][data-sentiq-motion-phase="enter"]',
  "animation: sentiqReducedOpacityEnter 80ms linear both !important",
  "transition-property: color, background-color, border-color, box-shadow, opacity !important",
  ".chat-input-wrapper[data-composer-version=\"5.1\"] > .chat-input-area::after",
  "transition: opacity 80ms linear !important",
  ".sentiq-loader.loader-chart .loader-chart-bar",
  ".response-inline-spinner::after",
  ".chat-cache-spinner::after",
  ".semantic-activity-mark::after",
  "[data-sentiq-motion-family=\"progress\"]",
  "#live-beta-panel .live-beta-orbit",
  "#live-beta-panel[data-state=\"listening\"] .live-beta-orbit-one",
  "#live-beta-panel[data-state=\"thinking\"] .live-beta-wave i",
  "will-change: auto !important",
]) assert.ok(refined.includes(token), `Pass 11.7 CSS missing ${token}`);

assert.equal(refined.includes("scroll-behavior: smooth"), false);
assert.equal(refined.includes("0.01ms"), false);
assert.equal(refined.includes("animation-duration: 1ms"), false);
assert.equal(refined.includes("*, *::before"), false, "No universal animation kill switch is allowed");

assert.ok(loaders.includes(".response-inline-loader"), "Static spinner must retain adjacent progress copy");
assert.ok(semanticProgress.includes(".semantic-activity-copy"), "Semantic progress must retain readable state text");
assert.ok(liveWorkspace.includes(".live-beta-state-row strong"), "Live voice must retain a textual state label");
assert.ok(liveWorkspace.includes(".live-beta-message"), "Live voice must retain explanatory status copy");

const assetImport = reducedEntry.indexOf('@import url("./77-asset-font-loading.css");');
const refinedImport = reducedEntry.indexOf('@import url("./78-refined-reduced-motion.css");');
assert.ok(assetImport >= 0 && refinedImport > assetImport, "Reduced-motion policy must load after all decorative layers");

console.log("Pass 11.7 reduced-motion gate passed: ambient motion, scale, parallax, loaders, Live voice, focus, opacity, and scrolling use intentional alternatives.");
