import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexHtml = readFileSync(resolve("frontend/index.html"), "utf8");
const settingsWorkspaceJs = readFileSync(resolve("frontend/scripts/features/settings-workspace.js"), "utf8");
const welcomeCompositionJs = readFileSync(resolve("frontend/scripts/features/welcome-composition.js"), "utf8");

// (b) the account template has no settings-account-state, no Connected identity, no Related settings and no Workspace controls
assert.ok(!settingsWorkspaceJs.includes("settings-account-state"), "Account template must not contain settings-account-state");
assert.ok(!settingsWorkspaceJs.includes("Connected identity"), "Account template must not contain 'Connected identity'");
assert.ok(!settingsWorkspaceJs.includes("Related settings"), "Account template must not contain 'Related settings'");
assert.ok(!settingsWorkspaceJs.includes("Workspace controls"), "Account template must not contain 'Workspace controls'");

// (c) the nav has no settings-workspace-nav-detail text
assert.ok(!settingsWorkspaceJs.includes("settings-workspace-nav-detail"), "Settings nav must not render settings-workspace-nav-detail");

// (d) the Trust panel has no <small> rows
const trustPanelMatch = settingsWorkspaceJs.match(/function createTrustPanel\(\)[\s\S]*?return panel;\s*\}/);
assert.ok(trustPanelMatch, "createTrustPanel function must exist");
assert.ok(!trustPanelMatch[0].includes("<small>"), "Trust panel must not contain any <small> description rows");

// (e) the welcome script never writes subtitle text
assert.ok(!welcomeCompositionJs.includes('setText(welcomeSubtitle,'), "Welcome composition script must never write subtitle text");
assert.ok(welcomeCompositionJs.includes('setHidden(welcomeSubtitle, true)'), "Welcome composition script must hide subtitle");

// (a) the new static strings in index.html for the sidebar, auth, name modal, composer tools and settings
assert.ok(indexHtml.includes("Plan &amp; usage") || indexHtml.includes("Plan & usage"), "index.html must contain 'Plan & usage'");
assert.ok(indexHtml.includes("New here?"), "index.html auth must contain 'New here?'");
assert.ok(indexHtml.includes("Forgot password?"), "index.html auth must contain 'Forgot password?'");
assert.ok(indexHtml.includes("Create account"), "index.html auth must contain 'Create account'");
assert.ok(indexHtml.includes("Your name"), "index.html name modal must contain 'Your name'");
assert.ok(indexHtml.includes("Used for greetings and your account."), "index.html name modal must contain 'Used for greetings and your account.'");
assert.ok(indexHtml.includes("Privacy &amp; support") || indexHtml.includes("Privacy & support"), "index.html trust modal must contain 'Privacy & support'");
assert.ok(/data-trust-tab="controls"[^>]*>Data<\/button>/.test(indexHtml), "index.html trust modal must contain Data tab");
assert.ok(!indexHtml.includes("How data is handled"), "index.html must not contain 'How data is handled'");

// Static removals in index.html
assert.ok(!indexHtml.includes('class="auth-menu-label"'), "index.html must not contain auth-menu-label element");
assert.ok(indexHtml.includes('<h2 hidden>Add your name</h2>'), "index.html must hide inner Add your name heading in name modal");
assert.ok(indexHtml.includes('id="live-beta-message" class="live-beta-message" hidden'), "live-beta-message must be hidden in index.html");
assert.ok(!indexHtml.includes("Getting Live voice ready."), "index.html must not contain 'Getting Live voice ready.'");

console.log("Pass: copy-ledger structural removals and invariants verified.");
