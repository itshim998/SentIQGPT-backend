import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = resolve(root, "frontend/scripts/features/websurf-presentation-refinement.js");
const moduleSource = readFileSync(modulePath, "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const css = readFileSync(resolve(root, "frontend/styles/modules/35-websurf-presentation.css"), "utf8");
const imports = readFileSync(resolve(root, "frontend/styles/modules/12-reduced-motion.css"), "utf8");
const {
  parseWebSurfSourceCount,
  splitWebSurfPublisherMeta,
  shouldShowFeaturedWebSurfSources,
} = await import(pathToFileURL(modulePath));

assert.equal(parseWebSurfSourceCount("Sources · 8"), 8);
assert.equal(parseWebSurfSourceCount("No count", 4), 4);
assert.deepEqual(splitWebSurfPublisherMeta("Reuters · Jul 19, 2026"), {
  publisher: "Reuters",
  detail: "Jul 19, 2026",
});
assert.equal(shouldShowFeaturedWebSurfSources({ sourceCount: 2, cardCount: 2, visualCardCount: 2 }), false);
assert.equal(shouldShowFeaturedWebSurfSources({ sourceCount: 4, cardCount: 3, visualCardCount: 1 }), true);
assert.equal(shouldShowFeaturedWebSurfSources({ sourceCount: 5, cardCount: 3, visualCardCount: 0 }), true);

assert.match(domRefs, /import "\.\.\/websurf-presentation-refinement\.js";/);
assert.match(imports, /@import url\("\.\/35-websurf-presentation\.css"\);/);
assert.match(moduleSource, /websurf-v2-search-status/);
assert.match(moduleSource, /websurf-v2-publisher-name/);
assert.match(moduleSource, /websurf-v2-citation-chip-mark/);
assert.match(moduleSource, /websurf-v2-source-sheet-header/);
assert.match(moduleSource, /aria-modal/);
assert.match(moduleSource, /event\.key === "Escape"/);
assert.match(moduleSource, /event\.key !== "Tab"/);
assert.match(moduleSource, /new MutationObserver/);
assert.match(moduleSource, /MOBILE_SOURCE_SHEET_QUERY/);
assert.doesNotMatch(moduleSource, /fetch\(|XMLHttpRequest|SentIQAPI|localStorage|sessionStorage|persistChatMessage|cloneNode/);

assert.match(css, /data-websurf-refinement-version="7\.1"/);
assert.match(css, /\.websurf-v2-search-status/);
assert.match(css, /\.websurf-v2-citation-chip-mark/);
assert.match(css, /\.websurf-v2-source-explorer\.is-mobile-source-sheet/);
assert.match(css, /position:\s*fixed/);
assert.match(css, /@media \(max-width: 720px\)/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /@media \(forced-colors: active\)/);
assert.doesNotMatch(css, /100vw|margin-(?:left|right):\s*-/);

console.log("WebSurf presentation refinement phase-gate checks passed.");
