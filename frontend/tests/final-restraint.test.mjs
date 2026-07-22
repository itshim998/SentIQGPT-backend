import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stylesheet = await readFile(new URL("../styles/modules/17-final-restraint.css", import.meta.url), "utf8");
const behavior = await readFile(new URL("../scripts/features/final-restraint.js", import.meta.url), "utf8");
const brand = await readFile(new URL("../scripts/shared/brand.js", import.meta.url), "utf8");

assert.ok(brand.includes('import "../features/final-restraint.js";'),
  "Pass 12.4 presentation must load before the rest of the frontend modules");

for (const token of [
  ".starter-actions",
  "#auth-user-chip",
  "#auth-logout-btn",
  "#auth-menu-toggle",
  "#auth-menu-panel",
  ".composer-action-subtitle",
  "body::before",
  ".main-content-glow",
  ".chat-input-wrapper::before",
  ".billing-plan-grid",
  ".memory-item",
  ".live-beta-orbit",
]) {
  assert.ok(stylesheet.includes(token), `Final restraint stylesheet is missing ${token}`);
}

for (const token of [
  "display: none !important",
  "animation: none !important",
  "backdrop-filter: none",
  "background: #8f78dc",
  "grid-template-columns: 1fr",
  "border-bottom: 1px solid rgba(255, 255, 255, 0.055)",
]) {
  assert.ok(stylesheet.includes(token), `Final restraint policy is missing ${token}`);
}

for (const token of [
  'const FINAL_RESTRAINT_VERSION = "12.4"',
  "ensureFinalRestraintStylesheet()",
  'setText("#account-upgrade-btn span", "Plan")',
  'setText("#settings-tab-button-memory", "Memory")',
  'setText("#support-email-link", "Email support")',
  "Guest chats are temporary. Sign in to keep conversations across devices.",
  "Files are processed only to complete your request.",
]) {
  assert.ok(behavior.includes(token), `Final restraint copy policy is missing ${token}`);
}

for (const forbidden of [
  "MutationObserver",
  "setInterval(",
  "requestAnimationFrame(",
  "AI assistant",
  "backend session cache",
  "generated artifacts",
]) {
  assert.equal(behavior.includes(forbidden), false, `Final restraint must not introduce ${forbidden}`);
}

console.log("Pass 12.4 final restraint gate passed: duplicate atmosphere, redundant controls, nested box treatment, ornamental motion, and technical copy are bounded by one reversible layer.");
