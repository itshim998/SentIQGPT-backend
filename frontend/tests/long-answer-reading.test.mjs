import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = resolve(root, "frontend/scripts/features/long-answer-reading.js");
const moduleSource = readFileSync(modulePath, "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const css = readFileSync(resolve(root, "frontend/styles/modules/34-long-answer-reading.css"), "utf8");
const imports = readFileSync(resolve(root, "frontend/styles/modules/12-reduced-motion.css"), "utf8");
const { classifyLongAnswerProfile, shouldBlockLatestRequest } = await import(pathToFileURL(modulePath));

assert.equal(classifyLongAnswerProfile({ textLength: 180, blockCount: 2, heightRatio: 0.3 }), false, "short answer stays compact");
assert.equal(classifyLongAnswerProfile({ textLength: 4300, blockCount: 28, heightRatio: 2.4 }), true, "long Markdown enters reading mode");
assert.equal(classifyLongAnswerProfile({ textLength: 1800, blockCount: 8, heightRatio: 1.4, codeBlocks: 2 }), true, "long code response enters reading mode");
assert.equal(classifyLongAnswerProfile({ textLength: 1050, blockCount: 8, heightRatio: 1.3, mathBlocks: 4 }), true, "long math response enters reading mode");
assert.equal(classifyLongAnswerProfile({ textLength: 1550, blockCount: 7, heightRatio: 1.35, tables: 1 }), true, "substantial table response enters reading mode");
assert.equal(classifyLongAnswerProfile({ textLength: 90, blockCount: 1, heightRatio: 1.5, images: 1 }), false, "short image response is not misclassified solely by media height");
assert.equal(classifyLongAnswerProfile({ textLength: 980, blockCount: 10, heightRatio: 1.35, codeBlocks: 1, mathBlocks: 1, tables: 1, images: 1, sourceCount: 4 }), true, "mixed rich response enters reading mode");

assert.equal(shouldBlockLatestRequest({ readingEarlier: true, targetIsLatest: true }), true);
assert.equal(shouldBlockLatestRequest({ readingEarlier: true, targetIsLatest: true, intentional: true }), false);
assert.equal(shouldBlockLatestRequest({ readingEarlier: false, targetIsLatest: true }), false);

assert.match(domRefs, /import "\.\.\/long-answer-reading\.js";/);
assert.match(imports, /@import url\("\.\/34-long-answer-reading\.css"\);/);
assert.match(moduleSource, /Object\.defineProperty\(chatMessages, "scrollTo"/);
assert.match(moduleSource, /shouldBlockLatestRequest/);
assert.match(moduleSource, /captureReadingAnchor/);
assert.match(moduleSource, /preserveReadingPosition/);
assert.match(moduleSource, /new MutationObserver/);
assert.match(moduleSource, /new ResizeObserver/);
assert.match(moduleSource, /aria-label", "Sources"\);/);
assert.match(moduleSource, /Back to answer/);
assert.match(moduleSource, /aria-controls/);
assert.match(moduleSource, /websurf-v2-source-explorer/);
assert.match(moduleSource, /web-search-details/);
assert.doesNotMatch(moduleSource, /fetch\(|XMLHttpRequest|SentIQAPI|localStorage|sessionStorage|persistChatMessage|cloneNode/);

assert.match(css, /data-long-answer="true"[\s\S]*--sentiq-document-measure: 70ch/);
assert.match(css, /\.scroll-anchor-pill[\s\S]*background: rgba\(15, 18, 27, 0\.82\)/);
assert.match(css, /\.long-answer-source-nav/);
assert.match(css, /\.long-answer-source-jump/);
assert.match(css, /\.long-answer-source-return/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /@media \(forced-colors: active\)/);
assert.doesNotMatch(css, /100vw|position:\s*fixed|margin-(?:left|right):\s*-/);

console.log("Long-answer reading mode phase-gate checks passed.");
