import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const modelSource = await readFile(new URL("../scripts/features/ui-state-model.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../scripts/features/ui-state-runtime.js", import.meta.url), "utf8");
const bridgeSource = await readFile(new URL("../scripts/features/ui-state-bridge.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/54-central-ui-state.css", import.meta.url), "utf8");

const modelUrl = `data:text/javascript;base64,${Buffer.from(modelSource).toString("base64")}`;
const {
  UI_PRIMARY_STATES,
  UI_STATE_PRIORITY,
  deriveUIState,
  createUIStateStore,
  normalizeUIFacts,
} = await import(modelUrl);

const cases = [
  ["guest-empty", {}],
  ["signed-in-empty", { authKnown: true, authenticated: true }],
  ["ready", { authKnown: true, authenticated: true, hasMessages: true }],
  ["drafting", { hasMessages: true, draftLength: 3 }],
  ["drafting", { attachmentCount: 1 }],
  ["drafting", { hasSelectionContext: true }],
  ["uploading", { uploadingCount: 1, draftLength: 5 }],
  ["tool-selected", { selectedTool: "websurf", draftLength: 2 }],
  ["streaming", { streaming: true, selectedTool: "image" }],
  ["background-task", { backgroundTask: true, hasMessages: true }],
  ["error-recoverable", { recoverableError: true, streaming: true }],
  ["reading-history", { readingHistory: true, hasMessages: true }],
  ["live-active", { liveActive: true, recoverableError: true, uploadingCount: 2 }],
];

for (const [expected, facts] of cases) {
  assert.equal(deriveUIState(facts).primary, expected, `Expected ${expected}`);
}

assert.deepEqual(new Set(UI_PRIMARY_STATES), new Set([
  "guest-empty",
  "signed-in-empty",
  "ready",
  "drafting",
  "uploading",
  "tool-selected",
  "streaming",
  "background-task",
  "error-recoverable",
  "reading-history",
  "live-active",
]));
assert.equal(UI_STATE_PRIORITY[0], "live-active");
assert.equal(UI_STATE_PRIORITY.at(-1), "ready");

const booleanKeys = [
  "authenticated",
  "hasMessages",
  "hasSelectionContext",
  "streaming",
  "backgroundTask",
  "recoverableError",
  "readingHistory",
  "liveActive",
];
for (let mask = 0; mask < (1 << booleanKeys.length); mask += 1) {
  const facts = { authKnown: true };
  booleanKeys.forEach((key, index) => { facts[key] = Boolean(mask & (1 << index)); });
  facts.draftLength = mask % 3 === 0 ? 12 : 0;
  facts.attachmentCount = mask % 5 === 0 ? 1 : 0;
  facts.uploadingCount = mask % 7 === 0 ? 1 : 0;
  facts.selectedTool = mask % 11 === 0 ? "deep-research" : "";
  const result = deriveUIState(facts);
  assert.ok(UI_PRIMARY_STATES.includes(result.primary), `Unknown primary state ${result.primary}`);
  assert.equal(new Set(result.flags).size, result.flags.length, "Flags must be unique");
  assert.deepEqual([...result.flags].sort(), result.flags, "Flags must be stable and sorted");
  assert.equal(result.busy, Boolean(
    result.facts.uploadingCount > 0
    || result.facts.streaming
    || result.facts.backgroundTask
    || result.facts.liveActive
  ));
}

const normalized = normalizeUIFacts({
  draftLength: -4,
  attachmentCount: "2.9",
  uploadingCount: Number.NaN,
  selectedTool: "Not valid!",
});
assert.equal(normalized.draftLength, 0);
assert.equal(normalized.attachmentCount, 2);
assert.equal(normalized.uploadingCount, 0);
assert.equal(normalized.selectedTool, "");

let emissions = 0;
const store = createUIStateStore({}, { clock: () => 1234 });
store.subscribe(() => { emissions += 1; });
assert.equal(emissions, 1, "Subscription should receive the current state once");
store.transaction((state) => {
  state.patch({ hasMessages: true }, { source: "test" });
  state.patch({ draftLength: 7 }, { source: "test" });
}, { source: "test", reason: "batched" });
assert.equal(emissions, 2, "A transaction should emit one derived transition");
assert.equal(store.getState().primary, "drafting");
assert.equal(store.getState().transition.changedAt, 1234);
store.patch({ draftLength: 7 }, { source: "test" });
assert.equal(emissions, 2, "Identical facts must not emit a redundant transition");

for (const token of [
  'UI_STATE_VERSION = "9.1"',
  "resolvePrimaryState",
  "createUIStateStore",
  "transaction",
  "auth-pending",
  "flagsText",
]) assert.ok(modelSource.includes(token), `Model missing ${token}`);

for (const token of [
  "data-sentiq-ui-state",
  "data-sentiq-ui-flags",
  "sentiq-ui-state-change",
  "sentiq-ui-signal",
  "window.SentIQUIState",
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const token of [
  "composer-input",
  "history-scroll",
  "historyScroller",
  "sentiq-auth-changed",
  "data-attachment-state",
  "data-deep-research-status",
  "failure-recovery-panel",
  "liveIsActive",
  "requestAnimationFrame",
]) assert.ok(bridgeSource.includes(token), `Bridge missing ${token}`);

for (const source of [modelSource, runtimeSource, bridgeSource]) {
  for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "XMLHttpRequest", "indexedDB"]) {
    assert.equal(source.includes(forbidden), false, `Central UI state layer must not own ${forbidden}`);
  }
}

assert.ok(domRefsSource.includes('import "../ui-state-runtime.js";'));
assert.ok(domRefsSource.includes('import "../ui-state-bridge.js";'));
assert.ok(
  domRefsSource.indexOf('import "../ui-state-runtime.js";') < domRefsSource.indexOf('import "../ui-state-bridge.js";'),
  "Runtime must initialize before the compatibility bridge",
);
assert.ok(importsSource.includes('@import url("./54-central-ui-state.css");'));

for (const token of [
  'data-sentiq-ui-version="9.1"',
  'data-sentiq-ui-state="drafting"',
  'data-sentiq-ui-state="uploading"',
  'data-sentiq-ui-state="tool-selected"',
  'data-sentiq-ui-state="streaming"',
  'data-sentiq-ui-state="background-task"',
  'data-sentiq-ui-state="error-recoverable"',
  'data-sentiq-ui-state="reading-history"',
  'data-sentiq-ui-state="live-active"',
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) assert.ok(cssSource.includes(token), `State CSS missing ${token}`);

console.log("Pass 9.1 central UI state model phase gate passed.");
