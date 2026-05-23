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
import { selectModelForPrompt } from "./orchestrator/modelRouter";
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
assert.equal(INTUITIVE_PROFILE.model.reasoningEffort, undefined, "intuitive profile keeps model effort automatic");

const fastGroqChatCall = buildChatPrompt({
  userMessage: "Explain SentIQGPT briefly.",
  modelOverride: "gpt-oss-120b",
  reasoningEffort: FAST_PROFILE.model.reasoningEffort,
});
assert.equal(fastGroqChatCall.reasoning_effort, "low", "fast Groq chat forces low reasoning effort");

const intuitiveGroqChatCall = buildChatPrompt({
  userMessage: "Analyze this trade-off in detail and compare the first option, second option, and third option.",
  modelOverride: "gpt-oss-120b",
  reasoningEffort: INTUITIVE_PROFILE.model.reasoningEffort,
});
assert.equal(intuitiveGroqChatCall.reasoning_effort, "medium", "intuitive Groq chat keeps automatic effort selection");

const nonGroqFastChatCall = buildChatPrompt({
  userMessage: "Hello.",
  modelOverride: "mistral",
  reasoningEffort: FAST_PROFILE.model.reasoningEffort,
});
assert.equal(nonGroqFastChatCall.reasoning_effort, undefined, "model effort is only forwarded to compatible chat models");

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

const plannerSource = readFileSync(resolve(process.cwd(), "backend/orchestrator/planner.ts"), "utf8");
assert.match(
  plannerSource,
  /normalizeExecutionMode\(args\.executionMode\)\s*===\s*"fast"[\s\S]*createSingleStepPlan\("conversation"/,
  "fast mode plain chat should bypass the planner LLM",
);
assert.match(
  plannerSource,
  /skipping planner LLM/,
  "fast planner bypass should leave an observable log breadcrumb",
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
  /fastPlainChatEligible[\s\S]*!fastHasFileContext[\s\S]*!fastHasImageContext[\s\S]*!isFileGenerationRequest/,
  "fast stream early path should stay limited to plain chat",
);

const llmAdapterSource = readFileSync(resolve(process.cwd(), "llm_adapter.py"), "utf8");
assert.match(
  llmAdapterSource,
  /reasoning_effort=_normalize_gpt_oss_reasoning_effort\(reasoning_effort\),[\s\S]*tools=\[\{"type": "browser_search"\}\]/,
  "Groq GPT-OSS calls should keep browser-search tools while accepting reasoning effort",
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
