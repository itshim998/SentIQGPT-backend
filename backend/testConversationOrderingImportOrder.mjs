import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const main = fs.readFileSync(path.join(root, "frontend/scripts/main.js"), "utf8");
const auth = fs.readFileSync(path.join(root, "frontend/scripts/services/auth.js"), "utf8");

const storageIndex = main.indexOf('import "./services/storage.js";');
const apiIndex = main.indexOf('import "./services/api.js";');
const authIndex = main.indexOf('import "./services/auth.js";');
const controllerIndex = main.indexOf('import "./features/chat-controller.js";');

assert.ok(storageIndex >= 0 && apiIndex >= 0 && authIndex >= 0 && controllerIndex >= 0);
assert.ok(storageIndex < apiIndex, "storage must exist before API/policies");
assert.ok(apiIndex < authIndex, "API must exist before auth imports the ordering guards");
assert.ok(authIndex < controllerIndex, "all ordering guards must be installed before chat-controller startup");

assert.match(auth, /^import "\.\/conversation-ordering-policy\.js";/m);
assert.match(auth, /^import "\.\/conversation-ordering-hydration-hardening\.js";/m);
assert.match(auth, /^import "\.\/conversation-special-mode-activity\.js";/m);

console.log("PASS | Conversation ordering guards install synchronously before chat-controller startup.");
