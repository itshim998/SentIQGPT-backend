import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAILURE_RECOVERY_STATES,
  FAILURE_RECOVERY_TOOLS,
  getAttachmentRecoveryStatus,
  getFailureRecoveryCopy,
  inferFailureRecoveryState,
  inferFailureRecoveryTool,
  isCompleteFailureRecoveryMatrix,
  shouldRestoreComposerDraft,
} from "../scripts/features/failure-recovery-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const feature = fs.readdirSync(path.join(root, "scripts/features"))
  .filter((name) => name.startsWith("failure-recovery") && name.endsWith(".js"))
  .map((name) => fs.readFileSync(path.join(root, "scripts/features", name), "utf8"))
  .join("\n");
const css = ["43-failure-recovery.css", "44-failure-recovery-composer.css"]
  .map((name) => fs.readFileSync(path.join(root, "styles/modules", name), "utf8"))
  .join("\n");
const domRefs = fs.readFileSync(path.join(root, "scripts/features/chat/dom-refs.js"), "utf8");
const imports = fs.readFileSync(path.join(root, "styles/modules/12-reduced-motion.css"), "utf8");

assert.deepEqual(FAILURE_RECOVERY_STATES, ["running", "successful", "partial", "cancelled", "failed"]);
assert.equal(isCompleteFailureRecoveryMatrix(), true);
for (const tool of ["response", "websurf", "image", "chart", "document", "deep-research"]) {
  assert.ok(FAILURE_RECOVERY_TOOLS[tool]);
  for (const state of FAILURE_RECOVERY_STATES) assert.ok(FAILURE_RECOVERY_TOOLS[tool][state]);
}

assert.equal(inferFailureRecoveryTool({ classes: "deep-research-card failed" }), "deep-research");
assert.equal(inferFailureRecoveryTool({ classes: "websurf-v2-panel" }), "websurf");
assert.equal(inferFailureRecoveryTool({ classes: "image-generation-card" }), "image");
assert.equal(inferFailureRecoveryTool({ classes: "message-chart-container" }), "chart");
assert.equal(inferFailureRecoveryTool({ classes: "generated-file-panel" }), "document");
assert.equal(inferFailureRecoveryState({ status: "interrupted", text: "Partial output preserved" }), "partial");
assert.equal(inferFailureRecoveryState({ status: "stopped" }), "cancelled");
assert.equal(inferFailureRecoveryState({ text: "Something went wrong. Try again." }), "failed");
assert.equal(inferFailureRecoveryState({ classes: "is-ready" }), "successful");
assert.equal(inferFailureRecoveryState({ status: "aria-busy" }), "running");
assert.match(getFailureRecoveryCopy("websurf", "failed").message, /Search didn't finish/);
assert.match(getFailureRecoveryCopy("document", "partial").message, /draft is preserved/);

assert.equal(shouldRestoreComposerDraft("", "original prompt"), true);
assert.equal(shouldRestoreComposerDraft("newer draft", "original prompt"), false);
assert.equal(getAttachmentRecoveryStatus(2, 2), "preserved");
assert.equal(getAttachmentRecoveryStatus(2, 0), "reattach");
assert.equal(getAttachmentRecoveryStatus(0, 0), "none");

for (const required of [
  "capture(source)",
  "captureFailureRecoveryScroll",
  "restoreScroll",
  "restoreDraft",
  "restoreMode",
  "getAttachmentSnapshot",
  "failure-recovery-panel",
  "aria-describedby",
  "sessionStorage",
  "failureRecoveryState",
  "failure-recovery-tray",
  "scheduleToastRecovery",
  "scheduleCancelledRecovery",
  "hasRecoveryForSnapshot",
]) assert.ok(feature.includes(required), `missing ${required}`);

assert.ok(feature.includes("#send-btn"));
assert.ok(feature.includes('event.key === "Enter"'));
assert.ok(feature.includes(".composer-attachment"));
assert.ok(feature.includes("deep-research-mode-bar"));
assert.ok(feature.includes("web-search-mode-bar"));
assert.ok(feature.includes("image-mode-bar"));
assert.ok(feature.includes("requestAnimationFrame(() => window.requestAnimationFrame"));
assert.ok(feature.includes("toastContainer"));
assert.ok(feature.includes("Review and retry"));
assert.ok(feature.includes("failureRecoveryRequest"));
assert.ok(feature.includes("snapshot.completedAt"));
assert.ok(feature.includes("message.dataset.responseStatus"));
assert.ok(!/\bfetch\s*\(/.test(feature));
assert.ok(!/SentIQAPI|sendMessageStream|provider|model_used|call_id/.test(feature));
assert.ok(!/localStorage/.test(feature));

assert.ok(domRefs.includes('import "../failure-recovery.js";'));
assert.ok(imports.includes('@import url("./43-failure-recovery.css");'));
assert.ok(imports.includes('@import url("./44-failure-recovery-composer.css");'));
assert.ok(css.includes("failure-recovery-preservation"));
assert.ok(css.includes("failure-recovery-tray"));
assert.ok(css.includes("@media (max-width: 600px)"));
assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"));
assert.ok(css.includes("@media (forced-colors: active)"));
assert.ok(!css.includes("100vw"));
assert.ok(!/margin-(?:left|right):\s*-/.test(css));
assert.ok(!/position:\s*fixed/.test(css));

console.log("Pass 7.5 failure recovery phase gate passed.");
