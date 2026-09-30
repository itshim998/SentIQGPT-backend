import assert from "node:assert/strict";

// Setup minimal DOM mocks for Node test environment
if (!globalThis.window) {
  globalThis.window = globalThis;
}
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
if (!globalThis.document) {
  globalThis.document = {
    getElementById: () => null,
    head: { appendChild: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, setAttribute: () => {}, classList: { add: () => {} } }),
    documentElement: { dataset: {}, classList: { contains: () => false, add: () => {} } },
    addEventListener: () => {},
  };
}

const {
  collapseAdjacentDuplicateChatMessages,
  getMessageMergeKey,
  mergeStoredMessage,
  normalizeMessageContentForDedup,
} = await import("../scripts/services/storage.js");

// Test 1: Content normalization
assert.equal(normalizeMessageContentForDedup("Phuchka"), "Phuchka");
assert.equal(normalizeMessageContentForDedup("Generate image: Phuchka"), "Phuchka");
assert.equal(normalizeMessageContentForDedup("  generate   image:   Phuchka  "), "Phuchka");
assert.equal(normalizeMessageContentForDedup("GENERATE IMAGE: A sunny beach"), "A sunny beach");
assert.equal(normalizeMessageContentForDedup("A regular text message"), "A regular text message");
console.log("PASS normalizeMessageContentForDedup tests");

// Test 2: getMessageMergeKey
const localAssistantImage = {
  id: "assistant-req-123",
  role: "assistant",
  clientRequestId: "req-123",
  meta: {
    type: "image",
    imageUrl: "https://storage.example.com/chat/generated-1.webp",
    storagePath: "chats/chat-1/generated-1.webp",
  },
};

const serverAssistantImage = {
  id: "server-uuid-456",
  role: "assistant",
  message_type: "image",
  image_url: "https://storage.example.com/chat/generated-1.webp",
  storage_path: "chats/chat-1/generated-1.webp",
  meta: {
    type: "image",
    imageUrl: "https://storage.example.com/chat/generated-1.webp",
    storagePath: "chats/chat-1/generated-1.webp",
  },
};

const localKey = getMessageMergeKey(localAssistantImage);
const serverKey = getMessageMergeKey(serverAssistantImage);
assert.equal(localKey, "image:chats/chat-1/generated-1.webp", "local assistant image key is keyed by image identity");
assert.equal(serverKey, "image:chats/chat-1/generated-1.webp", "server assistant image key is keyed by image identity");
assert.equal(localKey, serverKey, "local and server image representations share identical merge key");
console.log("PASS getMessageMergeKey image identity test");

// Test 3: collapseAdjacentDuplicateChatMessages for user prompt deduplication
const now = Date.now();
const localUserPrompt = {
  id: "user-req-123",
  role: "user",
  content: "Phuchka",
  clientRequestId: "req-123",
  timestamp: new Date(now).toISOString(),
};

const serverUserPrompt = {
  id: "server-user-uuid-789",
  role: "user",
  content: "Generate image: Phuchka",
  timestamp: new Date(now + 500).toISOString(),
};

const collapsedUser = collapseAdjacentDuplicateChatMessages([localUserPrompt, serverUserPrompt]);
assert.equal(collapsedUser.length, 1, "optimistic and server user prompts collapse to exactly 1 message");
assert.equal(collapsedUser[0].id, "server-user-uuid-789", "collapsed message adopts canonical server ID");
assert.equal(collapsedUser[0].clientRequestId, "req-123", "collapsed message preserves clientRequestId");
console.log("PASS user prompt collapse test");

// Test 4: collapseAdjacentDuplicateChatMessages for duplicate assistant images of same generation
const collapsedImages = collapseAdjacentDuplicateChatMessages([localAssistantImage, serverAssistantImage]);
assert.equal(collapsedImages.length, 1, "duplicate assistant images of same generation collapse to exactly 1 message");
assert.equal(collapsedImages[0].id, "server-uuid-456", "collapsed image adopts canonical server ID");
assert.equal(collapsedImages[0].meta.storagePath, "chats/chat-1/generated-1.webp");
console.log("PASS duplicate assistant image collapse test");

// Test 5: Distinct consecutive image generations must NOT collapse
const secondGenerationImage = {
  id: "assistant-req-789",
  role: "assistant",
  clientRequestId: "req-789",
  meta: {
    type: "image",
    imageUrl: "https://storage.example.com/chat/generated-2.webp",
    storagePath: "chats/chat-1/generated-2.webp",
  },
};

const distinctGenerations = collapseAdjacentDuplicateChatMessages([localAssistantImage, secondGenerationImage]);
assert.equal(distinctGenerations.length, 2, "independent consecutive image generations remain separate");
assert.equal(distinctGenerations[0].meta.storagePath, "chats/chat-1/generated-1.webp");
assert.equal(distinctGenerations[1].meta.storagePath, "chats/chat-1/generated-2.webp");
console.log("PASS independent image generations preservation test");

// Test 6: Full conversational sequence of 2 turns with server hydration
const fullSequence = [
  localUserPrompt,
  serverUserPrompt,
  localAssistantImage,
  serverAssistantImage,
  {
    id: "user-req-2",
    role: "user",
    content: "A cute dog",
    clientRequestId: "req-2",
    timestamp: new Date(now + 2000).toISOString(),
  },
  {
    id: "server-user-2",
    role: "user",
    content: "Generate image: A cute dog",
    timestamp: new Date(now + 2500).toISOString(),
  },
  secondGenerationImage,
  {
    id: "server-img-2",
    role: "assistant",
    message_type: "image",
    meta: {
      type: "image",
      imageUrl: "https://storage.example.com/chat/generated-2.webp",
      storagePath: "chats/chat-1/generated-2.webp",
    },
    timestamp: new Date(now + 3000).toISOString(),
  },
];

const collapsedSequence = collapseAdjacentDuplicateChatMessages(fullSequence);
assert.equal(collapsedSequence.length, 4, "full 2-generation sequence collapses to exactly 4 messages (2 user + 2 assistant)");
assert.equal(collapsedSequence[0].role, "user");
assert.equal(collapsedSequence[1].role, "assistant");
assert.equal(collapsedSequence[2].role, "user");
assert.equal(collapsedSequence[3].role, "assistant");
console.log("PASS full 2-turn image sequence test");

console.log("All image deduplication tests passed!");
