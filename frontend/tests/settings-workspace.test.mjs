import fs from "node:fs";
import assert from "node:assert/strict";

const workspace = fs.readFileSync(new URL("../scripts/features/settings-billing-workspace.js", import.meta.url), "utf8");
const billing = fs.readFileSync(new URL("../scripts/panels/billing-panel.js", import.meta.url), "utf8");
const settingsPanel = fs.readFileSync(new URL("../scripts/panels/settings-panel.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../styles/modules/47-settings-billing-workspace.css", import.meta.url), "utf8");
const imports = fs.readFileSync(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");

assert.match(workspace, /SETTINGS_WORKSPACE_VERSION\s*=\s*"8\.2"/);
assert.match(workspace, /settings-account-summary/);
assert.match(workspace, /settings-tab-support/);
assert.match(workspace, /settings-memory-toolbar/);
assert.match(workspace, /data-trust-tab="privacy"/);
assert.match(workspace, /data-trust-tab="support"/);
assert.match(workspace, /sentiq-billing-summary/);
assert.match(workspace, /sentiq-auth-changed/);
assert.match(workspace, /SentIQSettingsWorkspace/);
assert.doesNotMatch(workspace, /fetch\s*\(/);
assert.doesNotMatch(workspace, /localStorage|sessionStorage|indexedDB/);

assert.match(billing, /renderTokenAllowance/);
assert.match(billing, /renderCapability/);
assert.match(billing, /renderPlanOption/);
assert.match(billing, /billing-plan-overview/);
assert.match(billing, /billing-token-list/);
assert.match(billing, /billing-capability-list/);
assert.match(billing, /billing-plan-list/);
assert.match(billing, /sentiq-billing-summary/);

assert.match(settingsPanel, /features\/settings-billing-workspace\.js/);
assert.match(imports, /47-settings-billing-workspace\.css/);
assert.doesNotMatch(imports, /47-settings-workspace\.css|48-settings-workspace-responsive\.css/);

assert.match(css, /grid-template-columns:232px minmax\(0,1fr\)/);
assert.match(css, /billing-token-list/);
assert.match(css, /billing-plan-option/);
assert.match(css, /settings-memory-toolbar/);
assert.match(css, /settings-action-list/);
assert.match(css, /min-width:641px/);
assert.match(css, /max-width:640px/);
assert.match(css, /max-width:390px/);
assert.match(css, /prefers-reduced-motion:reduce/);
assert.match(css, /forced-colors:active/);
assert.doesNotMatch(css, /100vw/);

console.log("Pass 8.2 settings and billing workspace phase gate passed.");
