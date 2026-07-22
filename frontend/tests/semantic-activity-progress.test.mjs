import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SEMANTIC_ACTIVITY_LABELS,
  SEMANTIC_ACTIVITY_VERSION,
  getSemanticActivityLabel,
  getTimedSemanticActivity,
  inferSemanticActivity,
  isPublicSemanticActivityLabel,
} from "../scripts/features/semantic-activity-state.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const progressSource = fs.readFileSync(path.join(root, "scripts/features/semantic-activity-progress.js"), "utf8");
const domRefsSource = fs.readFileSync(path.join(root, "scripts/features/chat/dom-refs.js"), "utf8");
const cssImports = fs.readFileSync(path.join(root, "styles/modules/12-reduced-motion.css"), "utf8");
const css = fs.readFileSync(path.join(root, "styles/modules/42-semantic-activity-progress.css"), "utf8");

assert.equal(SEMANTIC_ACTIVITY_VERSION, "7.4");
assert.deepEqual(Object.values(SEMANTIC_ACTIVITY_LABELS), [
  "Thinking",
  "Reading files",
  "Searching",
  "Comparing sources",
  "Creating image",
  "Preparing document",
  "Generating chart",
]);
assert.equal(inferSemanticActivity({ text: "Thinking", hasAttachments: false }), "thinking");
assert.equal(inferSemanticActivity({ text: "Thinking", hasAttachments: true }), "reading-files");
assert.equal(inferSemanticActivity({ text: "Reading files" }), "reading-files");
assert.equal(inferSemanticActivity({ text: "Searching the web" }), "searching");
assert.equal(inferSemanticActivity({ text: "Reviewing sources" }), "comparing-sources");
assert.equal(inferSemanticActivity({ text: "Generating image" }), "creating-image");
assert.equal(inferSemanticActivity({ text: "Reading file" }), "preparing-document");
assert.equal(inferSemanticActivity({ text: "Preparing chart" }), "generating-chart");
assert.equal(inferSemanticActivity({ text: "Saving memory" }), "thinking");
assert.equal(getTimedSemanticActivity("searching"), "comparing-sources");
assert.equal(getSemanticActivityLabel("preparing-document"), "Preparing document");
Object.values(SEMANTIC_ACTIVITY_LABELS).forEach((label) => assert.equal(isPublicSemanticActivityLabel(label), true));

assert.match(domRefsSource, /import "\.\.\/semantic-activity-progress\.js";/);
assert.match(cssImports, /@import url\("\.\/42-semantic-activity-progress\.css"\);/);
assert.match(progressSource, /SEMANTIC_SEARCH_COMPARE_DELAY_MS/);
assert.match(progressSource, /hasVisibleAttachmentContext/);
assert.match(progressSource, /response-inline-loader/);
assert.match(progressSource, /sentiq-loader/);
assert.match(progressSource, /image-generation-card/);
assert.match(progressSource, /message-chart-container/);
assert.match(progressSource, /generated-file-panel/);
assert.match(progressSource, /aria-live/);
assert.match(progressSource, /aria-atomic/);
assert.match(progressSource, /attributeFilter: \["data-loader-kind", "class", "aria-busy", "src"\]/);
assert.doesNotMatch(progressSource, /setInterval|progressPercent|percentage/);
assert.doesNotMatch(progressSource, /fetch\s*\(|SentIQAPI|SentIQStorage|localStorage|sessionStorage|provider|model_used|call_id/);

assert.match(css, /semantic-activity-progress/);
assert.match(css, /semantic-legacy-loader/);
assert.match(css, /semantic-surface-progress/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /forced-colors/);
assert.doesNotMatch(css, /100vw|position:\s*fixed|margin-(?:left|right):\s*-/);

console.log("Pass 7.4 semantic activity progress checks passed.");
