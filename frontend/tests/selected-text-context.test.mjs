import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const controller = readFileSync(resolve(root, "frontend/scripts/features/chat-controller.js"), "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const html = readFileSync(resolve(root, "frontend/index.html"), "utf8");
const composerCss = readFileSync(resolve(root, "frontend/styles/modules/07-composer.css"), "utf8");

const selectionButtonStart = controller.indexOf("function ensureSelectionButton");
const selectionButtonEnd = controller.indexOf("function showSelectionButton", selectionButtonStart);
assert(selectionButtonStart > 0 && selectionButtonEnd > selectionButtonStart, "selection button handler should exist");
const selectionButtonBlock = controller.slice(selectionButtonStart, selectionButtonEnd);

assert.match(
  selectionButtonBlock,
  /addEventListener\(["']click["'],\s*\(\)\s*=>\s*\{[\s\S]*captureComposerSelectionContext\(payload\)/,
  "Ask SentIQ Chat should capture pending composer context",
);
assert.doesNotMatch(
  selectionButtonBlock,
  /handleSend|sendSelectionMessage|appendMessageBubble|persistChatMessage/,
  "selection click must not send, render a user message, or persist a message",
);
assert.doesNotMatch(controller, /function\s+handleSelectionAsk|Selected text:\\n/, "legacy immediate selection submission should be removed");

assert.match(html, /id="selected-context-bar"[\s\S]*id="selected-context-text"[\s\S]*id="clear-selected-context"/);
assert.match(domRefs, /selectedContextBar:[\s\S]*selectedContextText:[\s\S]*clearSelectedContext:/);
assert.match(controller, /clearSelectedContext\?\.addEventListener\(["']click["']/);
assert.match(controller, /requestAnimationFrame\(focusComposerAtEnd\)/, "capturing context should focus the composer");

const sendStart = controller.indexOf("async function handleSend");
const sendEnd = controller.indexOf("function toggleImageMode", sendStart);
assert(sendStart > 0 && sendEnd > sendStart, "normal send pipeline should exist");
const sendBlock = controller.slice(sendStart, sendEnd);
assert.match(sendBlock, /!message\s*&&\s*!selectedContextForRequest/, "selected context should make an empty composer sendable");
assert.match(sendBlock, /selectedContextForRequest\?\.selected_text/, "empty sends should use the selected phrase");
assert.match(sendBlock, /addSelectedContextToRecentMessages\(/, "normal AI requests should include selected context");
assert.match(sendBlock, /capturedSelectedContext/, "retry requests should retain selected context");
assert.doesNotMatch(sendBlock, /sendSelectionMessage/, "Send should use the normal chat pipeline");

assert.match(composerCss, /\.selected-context-bar\s*\{/);
assert.match(composerCss, /\.selected-context-remove:focus-visible/);
assert.match(composerCss, /@media\s*\(max-width:\s*720px\)[\s\S]*\.selected-context-bar/);

console.log("Selected-text composer context regression checks passed.");
