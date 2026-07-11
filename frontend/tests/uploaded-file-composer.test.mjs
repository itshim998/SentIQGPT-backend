import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const controller = readFileSync(resolve(root, "frontend/scripts/features/chat-controller.js"), "utf8");
const html = readFileSync(resolve(root, "frontend/index.html"), "utf8");
const composerCss = readFileSync(resolve(root, "frontend/styles/modules/07-composer.css"), "utf8");
const messageCss = readFileSync(resolve(root, "frontend/styles/modules/05-rich-responses.css"), "utf8");
const server = readFileSync(resolve(root, "backend/server.ts"), "utf8");

const composerStart = html.indexOf('<div class="chat-input-area">');
const attachmentArea = html.indexOf('id="file-preview-area"', composerStart);
assert(composerStart >= 0 && attachmentArea > composerStart, "attachment area must live inside the composer");

assert.match(controller, /function createComposerAttachment/);
assert.match(controller, /function processComposerAttachment/);
assert.match(controller, /attachment\.scope === composerAttachmentScope/);
assert.match(controller, /attachmentIdByAnalysisId/);
assert.match(controller, /function removeComposerAttachment/);
assert.match(controller, /function retryComposerAttachment/);

const sendStart = controller.indexOf("async function handleSend");
const sendEnd = controller.indexOf("function toggleImageMode", sendStart);
assert(sendStart > 0 && sendEnd > sendStart, "send pipeline should exist");
const sendBlock = controller.slice(sendStart, sendEnd);
assert.match(sendBlock, /hasComposerAttachments && !areComposerAttachmentsReady\(\)/, "Send must be blocked while any attachment is processing or failed");
assert.match(sendBlock, /requestComposerAttachments/, "the submitted turn must snapshot ready composer attachments");
assert.match(sendBlock, /buildMessageAttachmentMeta/, "the submitted turn must persist attachment metadata with the prompt");
assert.match(sendBlock, /removeComposerAttachmentsById\(composerAttachmentIdsForRequest\)/, "attachments should clear only after a successful send");

assert.doesNotMatch(controller, /Ready to upload|Uploading and analyzing|Analysis ready|Uploaded file:/, "legacy technical/upload-only UI copy must be removed");
assert.match(controller, /meta\?\.type === "message-attachments"/);
assert.match(controller, /preview\.attachments/);
assert.match(server, /meta\?\.type === "message-attachments"/);
assert.match(server, /previewJson: \{ attachments \}/);

assert.match(composerCss, /\.chat-input-area\.has-attachments/);
assert.match(composerCss, /\.composer-attachment-spinner/);
assert.match(composerCss, /\.composer-attachment-retry/);
assert.match(composerCss, /@media \(max-width: 720px\)[\s\S]*\.composer-attachment/);
assert.match(messageCss, /\.message-attachment-list/);
assert.match(messageCss, /\.message-attachment-card/);

console.log("Uploaded-file composer regression checks passed.");
