import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scriptSource = await readFile(
  new URL("../scripts/features/welcome-composition.js", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../styles/modules/20-welcome-composition.css", import.meta.url),
  "utf8",
);

for (const retiredToken of [
  "Continue recent work",
  "welcome-continuation",
  "has-recent-work",
  "getRecentConversation",
  "getHistoryRecencyLabel",
  "createContinuationSurface",
  "activateRecentConversation",
  "observer.observe(chatList",
]) {
  assert.equal(
    scriptSource.includes(retiredToken) || styleSource.includes(retiredToken),
    false,
    `Retired recent-work welcome behavior returned: ${retiredToken}`,
  );
}

for (const requiredToken of [
  'setText(welcomeEyebrow, "Welcome back")',
  "`Welcome back, ${greetingName}.`",
  "Start with a question, a file, or something you want to work through.",
  'welcomeScreen.dataset.welcomeAudience = signedIn ? "member" : "guest"',
  "window.requestAnimationFrame(render)",
]) {
  assert.ok(
    scriptSource.includes(requiredToken),
    `Welcome personalization must remain intact: ${requiredToken}`,
  );
}

assert.ok(
  styleSource.includes(".welcome-screen .starter-actions"),
  "Starter-action spacing must remain after the recent-work card is removed",
);

console.log("Welcome composition gate passed: recent work stays in chat history while greeting, starter actions, and account-aware copy remain intact.");
