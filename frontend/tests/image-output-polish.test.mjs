import assert from "node:assert/strict";
import {
  isGeneratedImageLabelText,
  isImageCopyControlLabel,
  normalizeGeneratedImageLabelText,
  writeImageToClipboard,
} from "../scripts/features/image-output-polish.js";

assert.equal(normalizeGeneratedImageLabelText(" •  GENERATED   IMAGE "), "generated image");
assert.equal(isGeneratedImageLabelText("Generated image"), true);
assert.equal(isGeneratedImageLabelText("· GENERATED IMAGE"), true);
assert.equal(isGeneratedImageLabelText("Creating image"), false);
assert.equal(isImageCopyControlLabel("Copy"), true);
assert.equal(isImageCopyControlLabel("Copy image"), true);
assert.equal(isImageCopyControlLabel("Copied"), false);

class FakeClipboardItem {
  static supports(type) {
    return type === "image/png";
  }

  constructor(data) {
    this.data = data;
  }
}

const pngBlob = new Blob(["png"], { type: "image/png" });
const writes = [];
let writeTextCalled = false;
const clipboard = {
  async write(items) {
    writes.push(items);
  },
  async writeText() {
    writeTextCalled = true;
  },
};

const result = await writeImageToClipboard("https://example.test/image.webp", {
  clipboard,
  ClipboardItemCtor: FakeClipboardItem,
  resolvePngBlob: async () => pngBlob,
});

assert.deepEqual(result, { mode: "image", mimeType: "image/png" });
assert.equal(writes.length, 1);
assert.equal(writeTextCalled, false);
assert.equal(await writes[0][0].data["image/png"], pngBlob);

const deniedClipboard = {
  async write() {
    throw new Error("clipboard denied");
  },
  async writeText() {
    writeTextCalled = true;
  },
};

writeTextCalled = false;
await assert.rejects(
  () => writeImageToClipboard("https://example.test/image.webp", {
    clipboard: deniedClipboard,
    ClipboardItemCtor: FakeClipboardItem,
    resolvePngBlob: async () => pngBlob,
  }),
  /clipboard denied/,
);
assert.equal(writeTextCalled, false);

await assert.rejects(
  () => writeImageToClipboard("https://example.test/image.webp", {
    clipboard: {},
    ClipboardItemCtor: FakeClipboardItem,
    resolvePngBlob: async () => pngBlob,
  }),
  (error) => error?.code === "image_clipboard_unsupported",
);

console.log("Image output polish tests passed.");
