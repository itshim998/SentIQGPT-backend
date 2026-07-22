import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const capabilitySource = await readFile(new URL("../scripts/features/capability-awareness.js", import.meta.url), "utf8");
const mobileNavigationSource = await readFile(new URL("../scripts/features/mobile-navigation.js", import.meta.url), "utf8");

for (const token of [
  "function setTextIfChanged",
  "OBSERVED_CAPABILITY_SELECTOR",
  "containsAddedCapabilityControl(records)",
  "node instanceof Element",
  "node.matches(OBSERVED_CAPABILITY_SELECTOR)",
  "node.querySelector?.(OBSERVED_CAPABILITY_SELECTOR)",
  "if (containsAddedCapabilityControl(records)) applySnapshot()",
]) {
  assert.ok(capabilitySource.includes(token), `Capability startup safety missing ${token}`);
}
assert.equal(capabilitySource.includes("help.textContent = capability.reason"), false,
  "Capability help copy must not replace text nodes on every snapshot");
assert.equal(capabilitySource.includes("subtitle.textContent = compactReason(capability)"), false,
  "Capability subtitles must use idempotent text writes");
assert.equal(capabilitySource.includes("record.addedNodes.length > 0"), false,
  "Capability observer must not refresh on every added node");

for (const token of [
  "function setClassIfChanged",
  'let observedOpen = sidebar.classList.contains("open")',
  "if (nextOpen === observedOpen) return",
  'setClassIfChanged(sidebar, "is-mobile-navigation-dragging", false)',
  'setClassIfChanged(sidebar, "is-mobile-navigation-dragging", true)',
]) {
  assert.ok(mobileNavigationSource.includes(token), `Mobile navigation startup safety missing ${token}`);
}
assert.equal(mobileNavigationSource.includes('sidebar.classList.remove("is-mobile-navigation-dragging")'), false,
  "Mobile navigation must not emit repeated no-op sidebar class mutations");
assert.equal(mobileNavigationSource.includes("const classChanged = records.some"), false,
  "Mobile navigation observer must react to open-state transitions, not every class mutation");

console.log("Startup observer safety gate passed: capability text synchronization and mobile navigation class observation are idempotent and bounded.");
