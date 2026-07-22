import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bridgeSource = await readFile(new URL("../scripts/features/conversation-continuity-event-bridge.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");

for (const token of [
  "#new-chat-btn",
  "#auth-logout-btn",
  "#auth-menu-logout-btn",
  "#account-signout-btn",
  ".chat-delete-btn",
  ".chat-rename-btn",
  ".chat-list-item[data-id]",
  "event.target instanceof HTMLElement",
  "event.target instanceof Element",
  "event.stopImmediatePropagation()",
  "control.click()",
  'document.addEventListener("click", normalizeNestedContinuityClick, true)',
]) assert.ok(bridgeSource.includes(token), `Continuity event bridge missing ${token}`);

for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest"]) {
  assert.equal(bridgeSource.includes(forbidden), false, `Continuity event bridge must not own ${forbidden}`);
}

assert.ok(
  domRefsSource.indexOf('import "../conversation-continuity.js";')
    < domRefsSource.indexOf('import "../conversation-continuity-event-bridge.js";'),
  "The nested-control bridge must run after the continuity guard is registered",
);

console.log("Pass 9.4 nested-control event bridge phase gate passed.");
