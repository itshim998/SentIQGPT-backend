import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const controllerPath = resolve("frontend/scripts/features/chat-controller.js");
const source = readFileSync(controllerPath, "utf8");

const oldDeclarations = `  let composerHintTimer = 0;\n  let composerHintIndex = 0;\n  let composerHintCycleId = 0;\n  let composerHintIntroConsumed = false;`;
const nextDeclarations = `  let composerHintIndex = 0;\n  let composerHintIntroConsumed = false;`;
if ((source.split(oldDeclarations).length - 1) !== 1) {
  throw new Error("Expected exactly one legacy composer hint declaration block.");
}

const blockStart = source.indexOf("  function clearComposerHintTimer() {");
const blockEnd = source.indexOf("  function ensureNameCapture", blockStart);
if (blockStart < 0 || blockEnd < 0 || blockEnd <= blockStart) {
  throw new Error("Could not locate the legacy composer hint animation block.");
}

const stableHintBlock = `  function getBaseComposerPlaceholder() {
    if (isNameCaptureRequired()) return "Add your name to continue...";
    if (imageMode) return "Describe the image you want to generate...";
    if (webSearchModeOverride) return "Ask about something current on the web...";
    return composerHintIntroConsumed ? \`Message \${PRODUCT_NAME}\` : "";
  }

  function shouldShowComposerHint() {
    return Boolean(
      composerHintOverlay
      && composerHintText
      && chatInput
      && !composerHintIntroConsumed
      && !chatInput.disabled
      && !chatInput.value.trim()
      && composerAttachments.length === 0
      && !imageMode
      && !webSearchModeOverride
      && !isNameCaptureRequired()
    );
  }

  function setComposerHintText(value) {
    if (!composerHintText) return;
    const next = String(value || "");
    if (composerHintText.textContent !== next) composerHintText.textContent = next;
  }

  function setComposerHintVisible(visible) {
    if (!composerHintOverlay) return;
    const next = Boolean(visible);
    if (composerHintOverlay.classList.contains("visible") !== next) {
      composerHintOverlay.classList.toggle("visible", next);
    }
  }

  function syncComposerHint() {
    if (chatInput) {
      const placeholder = getBaseComposerPlaceholder();
      if (chatInput.placeholder !== placeholder) chatInput.placeholder = placeholder;
    }
    if (!composerHintOverlay || !composerHintText) return;

    const visible = shouldShowComposerHint();
    setComposerHintVisible(visible);
    setComposerHintText(visible ? (COMPOSER_HINTS[composerHintIndex % COMPOSER_HINTS.length] || "") : "");
  }

`;

const nextSource = source
  .replace(oldDeclarations, nextDeclarations)
  .slice(0, blockStart)
  + stableHintBlock
  + source.slice(blockEnd);

for (const forbidden of [
  "composerHintTimer = window.setTimeout(step, 52)",
  "composerHintTimer = window.setTimeout(step, 28)",
  "composerHintTimer = window.setTimeout(step, 220)",
  "function cancelComposerHintAnimation()",
]) {
  if (nextSource.includes(forbidden)) throw new Error(`Legacy hint animation survived: ${forbidden}`);
}
if (!nextSource.includes("function setComposerHintText(value)")) {
  throw new Error("Stable composer hint writer was not installed.");
}

writeFileSync(controllerPath, nextSource, "utf8");
console.log("Applied stable composer hint policy to chat-controller.js.");
