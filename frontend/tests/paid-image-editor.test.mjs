import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EDIT_OPERATIONS, createEditPayload, createAnnotationPayload, createAnnotation, creditCost, editError, versionChain,
} from "../scripts/features/image-editor.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const one = "11111111-1111-4111-8111-111111111111";
const two = "22222222-2222-4222-8222-222222222222";
const three = "33333333-3333-4333-8333-333333333333";
const unrelated = "44444444-4444-4444-8444-444444444444";

assert.deepEqual(EDIT_OPERATIONS, ["edit", "replace_background"]);
assert.equal(creditCost("student_core", "fast"), 2);
assert.equal(creditCost("premium", "intuitive"), 2);
assert.equal(creditCost("pro", "fast"), 2);
assert.equal(creditCost("pro", "intuitive"), 8);

assert.deepEqual(createEditPayload({
  imageId: one, chatId: two, requestId: "retry-1",
  instruction: "  Make the sky orange  ", operation: "edit", mode: "fast",
}), {
  sourceImageId: one, conversationId: two, clientRequestId: "retry-1",
  prompt: "Make the sky orange", operation: "edit", executionMode: "fast",
});
assert.equal(createEditPayload({
  imageId: one, chatId: two, requestId: "retry-2",
  instruction: "Replace the wall", operation: "replace_background", mode: "intuitive",
}).executionMode, "intuitive");
for (const props of [
  { imageId: "latest" }, { chatId: "guest-1" }, { instruction: " " },
  { instruction: "x".repeat(2001) }, { operation: "erase_region" }, { operation: "remove_background" },
]) {
  assert.throws(() => createEditPayload({
    imageId: one, chatId: two, requestId: "same", instruction: "Edit the colors",
    operation: "edit", mode: "fast", ...props,
  }));
}
const all = [
  { id: one, createdAt: "2026-10-24T00:00:00Z" },
  { id: two, sourceImageId: one, createdAt: "2026-10-24T01:00:00Z" },
  { id: three, sourceImageId: two, createdAt: "2026-10-24T02:00:00Z" },
  { id: unrelated, createdAt: "2026-10-24T00:00:01Z" },
];
assert.deepEqual(versionChain(all, two).map((image) => image.id), [one, two, three]);
assert.deepEqual(versionChain(all, unrelated).map((image) => image.id), [unrelated]);
assert.deepEqual(versionChain(all, "missing"), []);
assert.match(editError({ code: "image_edit_in_progress" }), /Retry/);
assert.match(editError({ code: "image_edit_paid_only" }), /Essential/);

const controller = read("frontend/scripts/features/chat-controller.js");
const api = read("frontend/scripts/services/api.js");
const editor = read("frontend/scripts/features/image-editor.js");
const styles = read("frontend/styles/modules/12-reduced-motion.css");
const sheet = read("frontend/styles/modules/96-paid-image-editor.css");
assert.match(controller, /createImageEditor/);
assert.match(controller, /attachImageEditorAction\(actions, meta\)/);
assert.match(controller, /attachImageEditorAction\(actions, pendingMeta\)/);
assert.match(controller, /pendingMeta\.imageId = result\.image_id/);
assert.match(api, /apiRequest\("\/api\/images\/edit"/);
assert.match(api, /getImageQuota, editImage, deleteImage/);
assert.match(editor, /api\.getBillingMe\(\)/);
assert.match(editor, /api\.getChatImages\(chatId\)/);
assert.match(editor, /api\.editImage\(payload\)/);
assert.match(editor, /crypto\?\.randomUUID/);
assert.match(editor, /image credits on success/);
assert.match(editor, /Saving a drawing uses no generation credits/);
assert.match(editor, /api\.saveImageAnnotation\(payload\)/);
assert.match(api, /apiRequest\("\/api\/images\/annotations"/);
assert.match(api, /apiRequest\("\/api\/images\/editor-capabilities"/);
const strokes = [{ color: "#FF0000", size: 6, points: [{ x: 0.2, y: 0.4 }, { x: 0.3, y: 0.6 }] }];
const markup = createAnnotationPayload({ imageId: one, chatId: two, requestId: "markup-1", strokes });
assert.deepEqual(Object.keys(markup).sort(), ["annotation", "clientRequestId", "conversationId", "sourceImageId"]);
assert.equal(markup.annotation.strokes[0].color, "#ff0000");
assert(!("prompt" in markup) && !("executionMode" in markup));
const guided = createEditPayload({ imageId: one, chatId: two, requestId: "ai-1", instruction: "Change the marked area", operation: "edit", mode: "fast", annotation: createAnnotation(strokes) });
assert.deepEqual(guided.annotation, markup.annotation);
assert.throws(() => createAnnotation([{ ...strokes[0], color: 'url(https://example.com)' }]));
assert.throws(() => createAnnotation([{ ...strokes[0], points: [{ x: Infinity, y: 0 }] }]));
assert.throws(() => createAnnotation([{ ...strokes[0], points: Array.from({ length: 4097 }, () => ({ x: 0, y: 0 })) }]));
assert.deepEqual(versionChain([
  { id: two, sourceImageId: one, createdAt: "1" }, { id: three, operation_metadata: { source_image_id: one }, createdAt: "2" },
], two).map(v => v.id), [two, three]);
assert.doesNotMatch(editor, /data-edit-action="erase"/);
assert.match(styles, /96-paid-image-editor\.css/);
assert.match(sheet, /prefers-reduced-motion/);
assert.match(sheet, /forced-colors/);
assert.match(sheet, /max-width: 760px/);
console.log("Paid image-editor policies, versioning, request contract and integration checks passed.");
