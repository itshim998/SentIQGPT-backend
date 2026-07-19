import fs from "node:fs";
import assert from "node:assert/strict";

const js = fs.readFileSync(new URL("../scripts/features/settings-workspace.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../styles/modules/47-settings-workspace.css", import.meta.url), "utf8");
const responsive = fs.readFileSync(new URL("../styles/modules/48-settings-workspace-responsive.css", import.meta.url), "utf8");

assert.match(js, /SETTINGS_WORKSPACE_VERSION\s*=\s*"8\.2"/);
assert.match(js, /createAccountPanel/);
assert.match(js, /createTrustPanel/);
assert.match(js, /activateTab/);
assert.match(js, /data-settings-trust-target/);
assert.match(js, /MutationObserver/);
assert.match(js, /sentiq-auth-changed/);
assert.match(js, /billing-current/);
assert.match(js, /billing-usage-grid/);
assert.match(js, /billing-plan-grid/);
assert.doesNotMatch(js, /fetch\s*\(/);
assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB/);

assert.match(css, /grid-template-columns:\s*236px minmax\(0, 1fr\)/);
assert.match(css, /billing-usage-workspace/);
assert.match(css, /billing-plan-row/);
assert.match(css, /memory-group/);
assert.match(css, /settings-account-definition-list/);
assert.match(css, /settings-workspace-link-list/);
assert.match(css, /forced-colors:\s*active/);
assert.doesNotMatch(css, /100vw/);

assert.match(responsive, /min-width:\s*641px/);
assert.match(responsive, /max-width:\s*1024px/);
assert.match(responsive, /max-width:\s*640px/);
assert.match(responsive, /grid-template-columns:\s*1fr/);
assert.match(responsive, /prefers-reduced-motion:\s*reduce/);

console.log("Pass 8.2 settings workspace phase gate passed.");
