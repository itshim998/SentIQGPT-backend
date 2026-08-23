import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const renderer = fs.readFileSync(new URL("../scripts/generation-rehydrated-renderer.js", import.meta.url), "utf8");
const bootstrap = fs.readFileSync(new URL("../scripts/bootstrap-guard.js", import.meta.url), "utf8");

test("rehydrated generations use the existing chat-controller renderer", () => {
  assert.match(renderer, /window\.SentIQChat/);
  assert.match(renderer, /appendMessageBubble\("assistant", renderer\.text\)/);
  assert.match(renderer, /sentiq-generation-rehydrated/);
  assert.match(renderer, /sentiq-generation-event/);
});

test("rehydrated renderer attaches callbacks to the canonical lifecycle entry", () => {
  assert.match(renderer, /getGenerationEntry/);
  assert.match(renderer, /rehydratedRendererCallbacks/);
  assert.match(renderer, /entry\.callbacks = \{/);
  assert.match(renderer, /onToken\(token\)/);
  assert.match(renderer, /onDone\(\)/);
});

test("rehydrated rendering is throttled and resumes when its chat becomes visible", () => {
  assert.match(renderer, /requestAnimationFrame/);
  assert.match(renderer, /flushVisibleChat/);
  assert.match(renderer, /chat-list-item\.active/);
});

test("bootstrap loads the renderer bridge before rehydration", () => {
  assert.match(bootstrap, /generation-rehydrated-renderer\.js/);
  assert.match(bootstrap, /generation-render-router\.js/);
  assert.ok(
    bootstrap.indexOf("generation-rehydrated-renderer.js") < bootstrap.indexOf("generation-rehydration.js"),
    "renderer bridge must be installed before rehydration begins",
  );
});
