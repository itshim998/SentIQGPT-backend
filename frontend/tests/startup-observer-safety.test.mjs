import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const capabilitySource = await readFile(new URL("../scripts/features/capability-awareness.js", import.meta.url), "utf8");
const mobileNavigationSource = await readFile(new URL("../scripts/features/mobile-navigation.js", import.meta.url), "utf8");
const attachmentContextSource = await readFile(new URL("../scripts/features/attachment-context-surface.js", import.meta.url), "utf8");
const chatControllerSource = await readFile(new URL("../scripts/features/chat-controller.js", import.meta.url), "utf8");

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

for (const token of [
  "function setHidden(element, hidden)",
  "function setAttribute(element, name, value)",
  "function scheduleMeasureSelectedOverflow()",
  'setClass(selectedBar, "has-preview-overflow", false)',
  'setClass(selectedBar, "is-preview-expanded", false)',
  "setHidden(expandButton, true)",
  "setHidden(expandButton, !overflows)",
  "if (measureFrame) return",
]) {
  assert.ok(attachmentContextSource.includes(token), `Attachment context idle safety missing ${token}`);
}
assert.equal(attachmentContextSource.includes('selectedBar.classList.remove("has-preview-overflow", "is-preview-expanded")'), false,
  "Selected-context measurement must not rewrite classes unconditionally");
assert.equal(attachmentContextSource.includes("expandButton.hidden = !overflows"), false,
  "Selected-context measurement must not rewrite hidden state unconditionally");
assert.equal(attachmentContextSource.includes("window.requestAnimationFrame(measureSelectedOverflow)"), false,
  "Selected-context measurement must be keyed and coalesced");

for (const token of [
  "function setComposerHintText(value)",
  "function setComposerHintVisible(visible)",
  "composerHintText.textContent !== next",
  'composerHintOverlay.classList.contains("visible") !== next',
  "chatInput.placeholder !== placeholder",
]) {
  assert.ok(chatControllerSource.includes(token), `Composer hint idle safety missing ${token}`);
}
for (const forbidden of [
  "composerHintTimer = window.setTimeout(step, 52)",
  "composerHintTimer = window.setTimeout(step, 28)",
  "composerHintTimer = window.setTimeout(step, 220)",
  "function cancelComposerHintAnimation()",
  "clearTimeout(compo  function",
]) {
  assert.equal(chatControllerSource.includes(forbidden), false, `Composer hint idle loop survived: ${forbidden}`);
}

console.log("Startup observer safety gate passed: capability, mobile navigation, attachment context, and composer hint updates are idempotent, coalesced, and bounded.");
