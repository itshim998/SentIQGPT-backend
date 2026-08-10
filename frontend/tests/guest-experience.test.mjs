import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const guestExperience = readFileSync("frontend/scripts/features/guest-experience.js", "utf8");
const welcomeComposition = readFileSync("frontend/scripts/features/welcome-composition.js", "utf8");
const brand = readFileSync("frontend/scripts/shared/brand.js", "utf8");
const promptBuilders = readFileSync("backend/ai/PromptBuilders.ts", "utf8");

assert.doesNotMatch(brand, /guest-observer-safety\.js/, "obsolete guest observer safety shim must not be loaded");
assert.match(brand, /import "\.\.\/features\/guest-experience\.js";/, "guest experience policy must load before chat-controller");

assert.match(guestExperience, /mutationObserver\.observe\(root, \{\s*subtree: true,\s*childList: true,\s*characterData: true,\s*\}\);/, "guest policy observer must observe structure/content only");
assert.doesNotMatch(guestExperience, /mutationObserver\.observe\(root, \{[\s\S]*attributes:\s*true/, "guest policy observer must never observe its own mutable attributes");
assert.match(guestExperience, /records\.some\(\(record\) => record\.type === "childList" \|\| record\.type === "characterData"\)/, "guest observer must filter structural/content mutations before scheduling UI work");

assert.match(welcomeComposition, /setText\(welcomeHeading, "How can I help\?"\)/, "guest heading must use the requested copy");
assert.match(welcomeComposition, /setHidden\(welcomeSubtitle, true\)/, "guest subtitle must be removed from the composition");
assert.match(welcomeComposition, /Log in to save your chats, get smarter responses, generate images, and more\./, "guest sign-in note must use the requested copy");

assert.match(guestExperience, /const GUEST_TEXT_LIMIT_TOKENS = 8_000;/, "guest client policy must expose the 8K trial limit");
assert.match(guestExperience, /executionMode: "fast"/, "guest requests must be forced to Fast mode");
assert.match(guestExperience, /webSearchMode: null/, "guest requests must not retain manual WebSurf mode");
assert.match(guestExperience, /setActionGuestState\("file-attach-btn"[\s\S]*disabled: true/, "Attach files must be auth-gated for guests");
assert.match(guestExperience, /setActionGuestState\("websurf-basic-btn"[\s\S]*disabled: true/, "WebSurf must be auth-gated for guests");
assert.match(guestExperience, /guestQuotaState\.exhausted/, "guest composer must react to exhausted quota state");
assert.match(guestExperience, /Sign in to continue/, "exhausted guest composer must show the sign-in continuation label");

assert.match(guestExperience, /SentIQAPI\.createConversation\("New Chat"\)/, "sign-in handoff must create a persisted conversation");
assert.match(guestExperience, /SentIQAPI\.syncChatMessages/, "sign-in handoff must persist the guest transcript");
assert.match(guestExperience, /SentIQAPI\.generateTitle/, "sign-in handoff must title the migrated conversation");
assert.match(promptBuilders, /auxiliary_budget: "title"[\s\S]*prefer: "groq"|prefer: "groq"[\s\S]*auxiliary_budget: "title"/, "title generation must remain Groq-backed");

console.log("Guest experience contract checks passed.");
