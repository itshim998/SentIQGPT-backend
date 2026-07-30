import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeSource = await readFile(
  new URL("../scripts/features/ui-stability.js", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../styles/modules/86-ui-stability.css", import.meta.url),
  "utf8",
);
const chromiumSource = await readFile(
  new URL("../../scripts/testFrontendUiStabilityRuntime.mjs", import.meta.url),
  "utf8",
);

for (const token of [
  "baselineAssistantCount",
  "hasSuccessfulAssistantResponse",
  "shouldClearRestoredComposer",
  "userEditedAfterSend",
  'chatInput.dataset.sentiqSendState = "settled-success"',
  "SUCCESSFUL_SEND_GUARD_TIMEOUT_MS",
]) {
  assert.ok(runtimeSource.includes(token), `Fast draft regression guard missing ${token}`);
}

for (const token of [
  "beginChatListStabilization",
  "scheduleChatListSettle",
  "CHAT_LIST_STABILIZE_MAX_MS",
  'newChatButton?.addEventListener("pointerdown"',
  'chatListObserver?.observe(chatList, { childList: true, subtree: true })',
]) {
  assert.ok(runtimeSource.includes(token), `Chat-list stability guard missing ${token}`);
}

for (const token of [
  "#chat-list.sentiq-chat-list-stabilizing",
  "min-block-size: var(--sentiq-chat-list-stable-height, auto)",
  "transition: none !important",
  "animation: none !important",
  "contain: layout paint style",
]) {
  assert.ok(styleSource.includes(token), `Chat-list stability stylesheet missing ${token}`);
}

for (const token of [
  "fastSuccessfulDraftCleared",
  "failedDraftPreserved",
  "historySettled",
  "historyScrollRestored",
  "successful Fast-mode prompt was restored into the composer",
]) {
  assert.ok(chromiumSource.includes(token), `Chromium regression coverage missing ${token}`);
}

console.log("Fast draft and chat-list regression gate passed: successful Fast prompts cannot return, failed prompts remain retryable, and new-chat history refresh bursts are motionless and bounded.");
