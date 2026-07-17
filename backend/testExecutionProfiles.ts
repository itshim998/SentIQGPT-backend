import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FAST_PROFILE,
  INTUITIVE_PROFILE,
  normalizeExecutionMode,
  resolveExecutionProfile,
} from "./orchestrator/executionProfile";
import { ChatRequestSchema, ImageGenerateRequestSchema } from "./validation/schemas";
import { buildContextFast } from "./context/contextBuilder";
import { buildChatPrompt } from "./ai/PromptBuilders";

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

const trustedProfileAlias = ChatRequestSchema.parse({
  message: "Hello",
  context: { trusted_profile: { display_name: "Sounak" } },
});
assert.equal(
  trustedProfileAlias.context?.trustedProfile?.displayName,
  "Sounak",
  "trusted profile context alias is accepted",
);

const defaultImageRequest = ImageGenerateRequestSchema.parse({ prompt: "Generate a clean study desk." });
assert.equal(defaultImageRequest.executionMode, "fast", "image requests default to fast mode");

const snakeImageAlias = ImageGenerateRequestSchema.parse({
  prompt: "Generate a clean study desk.",
  execution_mode: "intuitive",
});
assert.equal(snakeImageAlias.executionMode, "intuitive", "image execution_mode alias is accepted");

const camelImageAlias = ImageGenerateRequestSchema.parse({
  prompt: "Generate a clean study desk.",
  executionMode: "intuitive",
});
assert.equal(camelImageAlias.executionMode, "intuitive", "image executionMode alias is accepted");

for (const profile of [FAST_PROFILE, INTUITIVE_PROFILE]) {
  const serialized = JSON.stringify(profile);
  assert.doesNotMatch(serialized, /gemini|groq|openai|qwen|pollinations/i, "execution profiles must not name models");
}
assert.equal(FAST_PROFILE.model.reasoningEffort, "low", "fast profile requests low model effort");
assert.equal(INTUITIVE_PROFILE.model.reasoningEffort, "medium", "intuitive profile requests medium model effort");

const fastGroqChatCall = buildChatPrompt({
  userMessage: "Explain SentIQ Chat briefly.",
  modelOverride: "gpt-oss-120b",
  reasoningEffort: FAST_PROFILE.model.reasoningEffort,
});
assert.equal(fastGroqChatCall.reasoning_effort, "low", "fast Groq chat forces low reasoning effort");

const intuitiveGroqChatCall = buildChatPrompt({
  userMessage: "Analyze this trade-off in detail and compare the first option, second option, and third option.",
  modelOverride: "gpt-oss-120b",
  reasoningEffort: INTUITIVE_PROFILE.model.reasoningEffort,
});
assert.equal(intuitiveGroqChatCall.reasoning_effort, "medium", "intuitive Groq chat requests medium reasoning effort");

const nonGroqFastChatCall = buildChatPrompt({
  userMessage: "Hello.",
  modelOverride: "mistral",
  reasoningEffort: FAST_PROFILE.model.reasoningEffort,
});
assert.equal(nonGroqFastChatCall.reasoning_effort, undefined, "model effort is only forwarded to compatible chat models");

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

const plannerSource = readFileSync(resolve(process.cwd(), "backend/orchestrator/planner.ts"), "utf8");
assert.match(
  plannerSource,
  /return singleStep\("conversation", args\.userMessage\)/,
  "both modes enter one ordinary model turn",
);
assert.doesNotMatch(
  plannerSource,
  /classif|keyword|regex|route_classify/i,
  "execution planning must not infer prompt semantics",
);

const serverSource = readFileSync(resolve(process.cwd(), "backend/server.ts"), "utf8");
assert.match(serverSource, /FAST_STREAM_SYNC_GRACE_MS/, "fast streaming sync grace window should be explicit");
assert.match(serverSource, /chat\.stream\.fast/, "signed-in fast stream should use a distinct persistence path");
assert.match(serverSource, /waitForFastStreamSync/, "fast stream persistence should be allowed to defer");
assert.match(
  serverSource,
  /parsed\.data\.context\?\.trustedProfile\?\.displayName/,
  "fast stream should use cached trusted profile without blocking first token",
);
assert.match(
  serverSource,
  /fastPlainChatEligible[\s\S]*!fastHasFileContext[\s\S]*!fastHasImageContext/,
  "fast stream early path should be based on execution context, not prompt semantics",
);

const llmAdapterSource = readFileSync(resolve(process.cwd(), "llm_adapter.py"), "utf8");
assert.doesNotMatch(
  llmAdapterSource,
  /browser_search|code_interpreter/,
  "ordinary Groq calls must not expose provider-native tools or guidance",
);

async function main() {
  let cloudMemoryTouched = false;
  const throwingDb = {
    from() {
      cloudMemoryTouched = true;
      throw new Error("cloud memory should not be fetched in fast profile");
    },
  };

  const fastContext = await buildContextFast(
    {
      recent_messages: [{ role: "user", content: "Do you remember this local preference?" }],
      memories: [{ type: "preference", summary: "User prefers concise answers.", importance: 8 }],
      userMessage: "Do you remember this local preference?",
      conversationId: "00000000-0000-4000-8000-000000000101",
      clientRequestId: "request-context-handoff",
    },
    throwingDb as any,
    "user-1",
    { profile: FAST_PROFILE },
  );
  assert.equal(cloudMemoryTouched, false, "fast profile skips cloud memory fetch in fast context");
  assert.equal(
    fastContext.userDb,
    throwingDb,
    "fast context preserves the resolved database passed separately by the live chat route",
  );
  assert.equal(fastContext.conversationId, "00000000-0000-4000-8000-000000000101");
  assert.equal(fastContext.clientRequestId, "request-context-handoff");

  console.log("PASS | Execution profile regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
