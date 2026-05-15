import assert from "assert/strict";
import { resolveContextReferences } from "./context/referenceResolver";

function main(): void {
  const spitzImage = resolveContextReferences({
    tool: "image_generation",
    input: "Generate their image",
    recentMessages: [
      { role: "user", content: "Tell me about Spitz dogs" },
      {
        role: "assistant",
        content: "It looks like you're interested in Spitz dogs. They're fluffy companion dogs.",
      },
    ],
    memories: [
      { type: "project", summary: "The user previously researched cauliflower recipes.", importance: 9, scope: "global" },
    ],
  });
  assert.equal(spitzImage.needsClarification, false, "clear current-chat subject does not ask clarification");
  assert.match(spitzImage.resolved, /Spitz dogs/i, "image prompt resolves pronoun to current chat subject");
  assert.doesNotMatch(spitzImage.resolved, /cauliflower/i, "global topical memory does not override current chat");

  const newChatNoLeak = resolveContextReferences({
    tool: "image_generation",
    input: "Generate its image",
    recentMessages: [
      { role: "user", content: "I want information about Spitz dogs" },
    ],
    memories: [
      { type: "project", summary: "The user discussed cauliflower in a previous chat.", importance: 10, scope: "global" },
    ],
  });
  assert.match(newChatNoLeak.resolved, /Spitz dogs/i, "new chat uses current subject instead of old global topic");
  assert.doesNotMatch(newChatNoLeak.resolved, /cauliflower/i, "new chat image prompt avoids cross-chat topical leakage");

  const webSearch = resolveContextReferences({
    tool: "web_search",
    input: "search about it",
    recentMessages: [
      { role: "user", content: "Can you explain the transformer architecture?" },
    ],
  });
  assert.match(webSearch.resolved, /transformer architecture/i, "web search follow-up resolves vague subject");

  const chatScopedFallback = resolveContextReferences({
    tool: "conversation",
    input: "explain it again",
    recentMessages: [],
    memories: [
      { type: "project", summary: "Current chat topic is vector database indexing.", importance: 8, scope: "chat" },
      { type: "project", summary: "The user likes football.", importance: 8, scope: "global" },
    ],
  });
  assert.match(chatScopedFallback.resolved, /vector database indexing/i, "chat-scoped memory can resolve when conversation is empty");

  console.log("PASS | context awareness reference resolution regressions passed.");
}

main();
