import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const controller = readFileSync(resolve(root, "frontend/scripts/features/text-quota-controller.js"), "utf8");
const state = readFileSync(resolve(root, "frontend/scripts/features/text-quota-state.mjs"), "utf8");
const billingPanel = readFileSync(resolve(root, "frontend/scripts/panels/billing-panel.js"), "utf8");
const billingRoutes = readFileSync(resolve(root, "backend/billing/billingRoutes.ts"), "utf8");
const billingCss = readFileSync(resolve(root, "frontend/styles/modules/14-billing.css"), "utf8");

assert.match(controller, /Symbol\.for\("sentiq\.textQuotaController\.patched"\)/);
assert.match(controller, /API\.sendMessageStream\s*=\s*async function sendMessageStreamWithQuotaRetry/);
assert.match(controller, /API\.sendMessage\s*=\s*async function sendMessageWithQuotaRetry/);
assert.match(controller, /__sentiqQuotaRetry:\s*true/);
assert.match(controller, /intuitive_fast_required/);
assert.match(controller, /unified_text_insufficient_for_request/);
assert.match(controller, /executionMode:\s*"fast"/);
assert.match(controller, /Switched to Fast to protect your remaining tokens\./);
assert.match(controller, /setAttribute\("inert",\s*""\)/);
assert.match(controller, /textQuotaReadOnly/);
assert.match(controller, /sentiq-billing-refresh/);
assert.match(controller, /sentiq-auth-changed/);
assert.match(controller, /quota_ui_enabled/);
assert.doesNotMatch(controller, /nvidia|nemotron|groq|gemini|pollinations/i);

assert.match(state, /FAST_MINIMUM_REQUEST_TOKENS\s*=\s*256/);
assert.match(state, /INTUITIVE_ORDINARY_MINIMUM_TOKENS\s*=\s*1_500/);
assert.match(state, /INTUITIVE_HEAVY_MINIMUM_TOKENS\s*=\s*2_000/);
assert.match(state, /Text limit reached/);
assert.match(state, /Fast only/);
assert.doesNotMatch(state, /nvidia|nemotron|groq|gemini|pollinations/i);

assert.match(billingPanel, /import "\.\.\/features\/text-quota-controller\.js"/);
assert.match(billingPanel, /quota_ui_enabled === true/);
assert.match(billingPanel, /renderUnifiedTextMeter/);
assert.match(billingPanel, /sentiq-billing-summary/);
assert.match(billingRoutes, /quota_ui_enabled:/);
assert.match(billingRoutes, /rollout\.unifiedTextTokensV2 && rollout\.intuitiveQuotaUi/);
assert.match(billingCss, /\.text-quota-status/);
assert.match(billingCss, /\.is-text-quota-exhausted/);
assert.match(billingCss, /\.execution-mode-option\.is-quota-unavailable/);

console.log("Unified text quota controller contract checks passed.");
