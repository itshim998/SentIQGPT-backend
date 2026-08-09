import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const settings = fs.readFileSync(
  path.join(root, "frontend/scripts/panels/settings-panel.js"),
  "utf8",
);
const ordering = fs.readFileSync(
  path.join(root, "frontend/scripts/services/conversation-ordering-policy.js"),
  "utf8",
);

assert.match(ordering, /const MAX_STORED_CHATS = 50;/);
assert.match(settings, /FIXED_CHAT_LIMIT = Number\(Storage\?\.MAX_STORED_CHATS \|\| 50\)/);
assert.match(settings, /chatLimitInput\.disabled = true/);
assert.match(settings, /chatLimitInput\.readOnly = true/);
assert.match(settings, /Storage\.setConfig\("chat_limit", FIXED_CHAT_LIMIT\)/);
assert.doesNotMatch(settings, /parseInt\(chatLimitInput/);
assert.match(settings, /Conversations<\/span><span>\$\{stats\.chats\.count\} \/ \$\{FIXED_CHAT_LIMIT\}/);

console.log("PASS | Conversation retention limit is fixed at 50 across policy and settings UI.");
