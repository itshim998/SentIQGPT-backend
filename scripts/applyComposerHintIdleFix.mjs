import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const controllerRelativePath = "frontend/scripts/features/chat-controller.js";
const controllerPath = resolve(controllerRelativePath);
const verifiedControllerBase = "be03466661999b3ec3f4abed13b0b5d7b90f1923";
let source = readFileSync(controllerPath, "utf8");

if (source.includes("clearTimeout(compo  function getBaseComposerPlaceholder()")) {
  source = execFileSync("git", ["show", `${verifiedControllerBase}:${controllerRelativePath}`], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  console.log(`Recovered chat-controller.js from verified base ${verifiedControllerBase}.`);
}

const oldDeclarations = `  let composerHintTimer = 0;\n  let composerHintIndex = 0;\n  let composerHintCycleId = 0;\n  let composerHintIntroConsumed = false;`;
const nextDeclarations = `  let composerHintIndex = 0;\n  let composerHintIntroConsumed = false;`;

if (source.includes("function setComposerHintText(value)") && !source.includes(oldDeclarations)) {
  console.log("Stable composer hint policy is already present.");
  process.exit(0);
}
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

const blockReplaced = source.slice(0, blockStart) + stableHintBlock + source.slice(blockEnd);
const nextSource = blockReplaced.replace(oldDeclarations, nextDeclarations);

for (const forbidden of [
  "composerHintTimer = window.setTimeout(step, 52)",
  "composerHintTimer = window.setTimeout(step, 28)",
  "composerHintTimer = window.setTimeout(step, 220)",
  "function cancelComposerHintAnimation()",
  "clearTimeout(compo  function",
]) {
  if (nextSource.includes(forbidden)) throw new Error(`Legacy or malformed hint code survived: ${forbidden}`);
}
if (!nextSource.includes("function setComposerHintText(value)")) {
  throw new Error("Stable composer hint writer was not installed.");
}

writeFileSync(controllerPath, nextSource, "utf8");
execFileSync(process.execPath, ["--check", controllerPath], { stdio: "inherit" });
console.log("Applied and syntax-verified stable composer hint policy to chat-controller.js.");
