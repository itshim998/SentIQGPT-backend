import assert from "assert";
import {
  buildAnswerCacheKey,
  getCachedAnswer,
  isAnswerCacheable,
  setCachedAnswer,
  type AnswerCacheRequest,
} from "./cache/cacheManager";
import { cacheClear } from "./cache/cacheStore";

const baseRequest: AnswerCacheRequest = {
  userIntent: "What is the capital of France?",
  executionProfile: "knowledge",
  modelCapability: "general_knowledge",
  contextFingerprint: "none",
  toolFingerprint: "none",
  promptVersion: "knowledge-v1",
  deterministicKnowledge: true,
  hasConversationHistory: false,
  hasAttachments: false,
  isPersonalized: false,
  hasExplicitModelSelection: false,
  usesTools: false,
  usesWebSearch: false,
};

function expectUncacheable(overrides: Partial<AnswerCacheRequest>): void {
  assert.strictEqual(
    isAnswerCacheable({ ...baseRequest, ...overrides }),
    false,
    `request should not be cacheable: ${JSON.stringify(overrides)}`,
  );
}

cacheClear();

// Phase 1: deterministic, context-free knowledge is the only cacheable class.
assert.strictEqual(isAnswerCacheable(baseRequest), true);
setCachedAnswer(baseRequest, "Paris is the capital of France. This is a deterministic knowledge answer.");
assert.strictEqual(
  getCachedAnswer(baseRequest),
  "Paris is the capital of France. This is a deterministic knowledge answer.",
);

expectUncacheable({ deterministicKnowledge: false });
expectUncacheable({ executionProfile: "fast", deterministicKnowledge: false });
expectUncacheable({ executionProfile: "intuitive", deterministicKnowledge: false });
expectUncacheable({ modelCapability: "coding", deterministicKnowledge: false });
expectUncacheable({ hasConversationHistory: true });
expectUncacheable({ hasAttachments: true });
expectUncacheable({ isPersonalized: true });
expectUncacheable({ hasExplicitModelSelection: true });
expectUncacheable({ usesTools: true });
expectUncacheable({ usesWebSearch: true });
expectUncacheable({ contextFingerprint: "conversation:abc123" });
expectUncacheable({ toolFingerprint: "web-search:q=capital" });

// An unsafe request must behave as a cache miss even when its text matches a
// previously cached deterministic knowledge request.
const contextualSameText: AnswerCacheRequest = {
  ...baseRequest,
  hasConversationHistory: true,
  contextFingerprint: "conversation:abc123",
};
assert.strictEqual(getCachedAnswer(contextualSameText), undefined);

// Phase 2: every answer-identity dimension must affect the cache key.
const baselineKey = buildAnswerCacheKey(baseRequest);
for (const [field, value] of [
  ["userIntent", "What is the capital of Germany?"],
  ["executionProfile", "knowledge-v2"],
  ["modelCapability", "general_knowledge-v2"],
  ["contextFingerprint", "none-v2"],
  ["toolFingerprint", "none-v2"],
  ["promptVersion", "knowledge-v2"],
] as const) {
  const changed = buildAnswerCacheKey({
    ...baseRequest,
    [field]: value,
  });
  assert.notDeepStrictEqual(changed, baselineKey, `${field} must affect answer identity`);
}

console.log("Answer cache policy and key isolation tests passed.");
