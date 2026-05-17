import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FAST_PROFILE,
  INTUITIVE_PROFILE,
  normalizeExecutionMode,
  resolveExecutionProfile,
} from "./orchestrator/executionProfile";
import { ChatRequestSchema } from "./validation/schemas";
import { selectModelForPrompt } from "./orchestrator/modelRouter";
import { buildContextFast } from "./context/contextBuilder";

assert.equal(normalizeExecutionMode(undefined), "fast");
assert.equal(normalizeExecutionMode("fast"), "fast");
assert.equal(normalizeExecutionMode("intuitive"), "intuitive");
assert.equal(resolveExecutionProfile("intuitive").mode, "intuitive");
assert.equal(resolveExecutionProfile("something-else").mode, "fast");

const defaultRequest = ChatRequestSchema.parse({ message: "Hello" });
assert.equal(defaultRequest.executionMode, "fast", "chat requests default to fast mode");

const snakeAlias = ChatRequestSchema.parse({ message: "Hello", execution_mode: "intuitive" });
assert.equal(snakeAlias.executionMode, "intuitive", "execution_mode alias is accepted");

const camelAlias = ChatRequestSchema.parse({ message: "Hello", executionMode: "intuitive" });
assert.equal(camelAlias.executionMode, "intuitive", "executionMode alias is accepted");

for (const profile of [FAST_PROFILE, INTUITIVE_PROFILE]) {
  const serialized = JSON.stringify(profile);
  assert.doesNotMatch(serialized, /gemini|groq|openai|qwen|pollinations/i, "execution profiles must not name models");
}

const routingCases = [
  "Write a TypeScript function to debounce input.",
  "Solve 14x + 8 = 64.",
  "Analyze the attached image.",
  "Summarize this short note.",
];
for (const prompt of routingCases) {
  const fastModel = selectModelForPrompt(prompt);
  const intuitiveModel = selectModelForPrompt(prompt);
  assert.equal(fastModel, intuitiveModel, `mode-independent model routing for: ${prompt}`);
}

const assistantTextIdempotencyMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260517120000_add_assistant_text_client_request_id_unique.sql"),
  "utf8",
);
assert.match(
  assistantTextIdempotencyMigration,
  /messages_assistant_text_client_request_id_unique/,
  "assistant text messages need DB-level client_request_id idempotency",
);
assert.match(
  assistantTextIdempotencyMigration,
  /role\s*=\s*'assistant'/,
  "assistant text idempotency must be scoped to assistant messages",
);
assert.match(
  assistantTextIdempotencyMigration,
  /message_type\s*=\s*'text'/,
  "assistant text idempotency must be scoped to text messages",
);

async function main() {
  let cloudMemoryTouched = false;
  const throwingDb = {
    from() {
      cloudMemoryTouched = true;
      throw new Error("cloud memory should not be fetched in fast profile");
    },
  };

  await buildContextFast(
    {
      recent_messages: [{ role: "user", content: "Do you remember this local preference?" }],
      memories: [{ type: "preference", summary: "User prefers concise answers.", importance: 8 }],
      userMessage: "Do you remember this local preference?",
    },
    throwingDb as any,
    "user-1",
    { profile: FAST_PROFILE },
  );
  assert.equal(cloudMemoryTouched, false, "fast profile skips cloud memory fetch in fast context");

  console.log("PASS | Execution profile regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
