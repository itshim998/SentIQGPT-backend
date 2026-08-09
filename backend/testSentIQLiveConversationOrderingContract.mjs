import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const special = fs.readFileSync(
  path.join(root, "frontend/scripts/services/conversation-special-mode-activity.js"),
  "utf8",
);
const hardening = fs.readFileSync(
  path.join(root, "frontend/scripts/services/conversation-ordering-hydration-hardening.js"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260809123000_conversation_user_activity_ordering.sql"),
  "utf8",
);
const verification = fs.readFileSync(
  path.join(root, "supabase/verification/verify_conversation_user_activity_ordering.sql"),
  "utf8",
);

assert.match(special, /originalCommitLiveSession/);
assert.match(
  special,
  /const result = await originalCommitLiveSession\(sessionId, payload\);[\s\S]*await reconcileRemoteConversationCache\(API\)/,
  "Live commit must refresh authoritative remote ordering immediately",
);

assert.match(hardening, /isLiveTranscriptWithUserSpeech/);
assert.match(hardening, /Live transcript/);
assert.match(hardening, /You:\\s\*\\S/);
assert.match(hardening, /message\?\.role === "user" \|\| isLiveTranscriptWithUserSpeech\(message\)/);

assert.match(migration, /m\.message_type = 'live_transcript'/);
assert.match(migration, /m\.role = 'assistant'/);
assert.match(migration, /You:/);
assert.match(migration, /elsif new\.role = 'assistant'[\s\S]*new\.message_type = 'live_transcript'[\s\S]*You:/);
assert.match(verification, /live_user_touch/);
assert.match(verification, /m\.message_type = 'live_transcript'/);

console.log("PASS | SentIQ Live user-speech ordering contract is covered in DB, cache hydration, and post-commit refresh.");
