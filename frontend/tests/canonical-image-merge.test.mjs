import assert from "node:assert/strict";
import test from "node:test";

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
  getMessageMergeKey,
  normalizeMessageContentForDedup,
  mergeStoredMessage,
  canonicalizeChatMessages,
  collapseAdjacentDuplicateChatMessages,
} = await import("../scripts/services/storage.js");

const R1 = "req-test-r1-1111";
const R2 = "req-test-r2-2222";

const LOCAL_USER_R1 = {
  id: `user-${R1}`,
  role: "user",
  content: "Phuchka",
  clientRequestId: R1,
  timestamp: "2026-09-30T10:00:00.000Z",
};

const LOCAL_IMAGE_R1 = {
  id: `assistant-img-${R1}`,
  role: "assistant",
  content: "",
  clientRequestId: R1,
  meta: {
    type: "image",
    isPending: true,
    prompt: "Phuchka",
  },
  timestamp: "2026-09-30T10:00:00.500Z",
};

const SERVER_USER_R1 = {
  id: "srv-msg-user-1111",
  role: "user",
  content: "Generate image: Phuchka",
  clientRequestId: R1,
  timestamp: "2026-09-30T10:00:01.000Z",
};

const SERVER_IMAGE_R1 = {
  id: "srv-msg-img-1111",
  role: "assistant",
  content: "",
  clientRequestId: R1,
  message_type: "image",
  meta: {
    type: "image",
    imageUrl: "https://storage.supabase.co/sentiq-images/user/c1/img1.webp",
    storagePath: "user/c1/img1.webp",
    prompt: "Phuchka",
  },
  timestamp: "2026-09-30T10:00:02.000Z",
};

const LOCAL_USER_R2 = {
  id: `user-${R2}`,
  role: "user",
  content: "A golden retriever puppy",
  clientRequestId: R2,
  timestamp: "2026-09-30T10:05:00.000Z",
};

const LOCAL_IMAGE_R2 = {
  id: `assistant-img-${R2}`,
  role: "assistant",
  content: "",
  clientRequestId: R2,
  meta: {
    type: "image",
    isPending: true,
    prompt: "A golden retriever puppy",
  },
  timestamp: "2026-09-30T10:05:00.500Z",
};

const SERVER_USER_R2 = {
  id: "srv-msg-user-2222",
  role: "user",
  content: "Generate image: A golden retriever puppy",
  clientRequestId: R2,
  timestamp: "2026-09-30T10:05:01.000Z",
};

const SERVER_IMAGE_R2 = {
  id: "srv-msg-img-2222",
  role: "assistant",
  content: "",
  clientRequestId: R2,
  message_type: "image",
  meta: {
    type: "image",
    imageUrl: "https://storage.supabase.co/sentiq-images/user/c1/img2.webp",
    storagePath: "user/c1/img2.webp",
    prompt: "A golden retriever puppy",
  },
  timestamp: "2026-09-30T10:05:02.000Z",
};

test("Test 1: Interleaved [LOCAL_USER, LOCAL_IMAGE, SERVER_USER, SERVER_IMAGE] converges to exactly 2 messages", () => {
  const interleavedSequence = [
    LOCAL_USER_R1,
    LOCAL_IMAGE_R1,
    SERVER_USER_R1,
    SERVER_IMAGE_R1,
  ];

  const canonical = canonicalizeChatMessages(interleavedSequence);
  assert.equal(canonical.length, 2, `Expected 2 canonical messages, got ${canonical.length}`);
  
  const userMsg = canonical.find(m => m.role === "user");
  const assistantMsg = canonical.find(m => m.role === "assistant");
  
  assert.ok(userMsg, "Must contain a user message");
  assert.ok(assistantMsg, "Must contain an assistant message");
  assert.equal(userMsg.id, "srv-msg-user-1111", "User message must prefer server canonical UUID");
  assert.equal(assistantMsg.id, "srv-msg-img-1111", "Assistant message must prefer server canonical UUID");
  assert.equal(assistantMsg.meta?.imageUrl, "https://storage.supabase.co/sentiq-images/user/c1/img1.webp");

  const collapsed = collapseAdjacentDuplicateChatMessages(interleavedSequence);
  assert.equal(collapsed.length, 2, `collapseAdjacentDuplicateChatMessages must also yield exactly 2 messages, got ${collapsed.length}`);
});

test("Test 1b: Interleaved ordering with legacy null clientRequestId on server user still converges to 2 messages", () => {
  const serverUserLegacy = { ...SERVER_USER_R1, clientRequestId: null };
  const serverImageLegacy = { ...SERVER_IMAGE_R1, clientRequestId: null };
  const interleavedSequence = [
    LOCAL_USER_R1,
    LOCAL_IMAGE_R1,
    serverUserLegacy,
    serverImageLegacy,
  ];

  const canonical = canonicalizeChatMessages(interleavedSequence);
  assert.equal(canonical.length, 2, `Expected 2 messages with legacy null request IDs, got ${canonical.length}`);
  assert.equal(canonical[0].role, "user");
  assert.equal(canonical[1].role, "assistant");
});

test("Test 2: Consecutive independent generations [R1, R2] converge to exactly 4 messages", () => {
  const fullSequence = [
    LOCAL_USER_R1,
    LOCAL_IMAGE_R1,
    SERVER_USER_R1,
    SERVER_IMAGE_R1,
    LOCAL_USER_R2,
    LOCAL_IMAGE_R2,
    SERVER_USER_R2,
    SERVER_IMAGE_R2,
  ];

  const canonical = canonicalizeChatMessages(fullSequence);
  assert.equal(canonical.length, 4, `Expected 4 messages for two consecutive generations, got ${canonical.length}`);
  
  const users = canonical.filter(m => m.role === "user");
  const assistants = canonical.filter(m => m.role === "assistant");
  assert.equal(users.length, 2, "Expected 2 user prompts");
  assert.equal(assistants.length, 2, "Expected 2 assistant images");

  assert.equal(users[0].id, "srv-msg-user-1111");
  assert.equal(users[1].id, "srv-msg-user-2222");
  assert.equal(assistants[0].id, "srv-msg-img-1111");
  assert.equal(assistants[1].id, "srv-msg-img-2222");

  const collapsed = collapseAdjacentDuplicateChatMessages(fullSequence);
  assert.equal(collapsed.length, 4, "collapseAdjacentDuplicateChatMessages must also preserve all 4 messages");
});

test("Test 3: Two consecutive independent generations with different prompts remain separate", () => {
  const canonical = canonicalizeChatMessages([
    SERVER_USER_R1,
    SERVER_IMAGE_R1,
    SERVER_USER_R2,
    SERVER_IMAGE_R2,
  ]);
  assert.equal(canonical.length, 4);
  assert.equal(canonical[0].content, "Generate image: Phuchka");
  assert.equal(canonical[2].content, "Generate image: A golden retriever puppy");
});

test("Test 4: Two generated images with adjacent timestamps but different request IDs remain separate", () => {
  const imgA = {
    id: "img-turn-a",
    role: "assistant",
    message_type: "image",
    clientRequestId: "req-a",
    meta: { type: "image", imageUrl: "https://example.com/a.png", storagePath: "path/a.png" },
    timestamp: "2026-09-30T10:00:00.000Z",
  };
  const imgB = {
    id: "img-turn-b",
    role: "assistant",
    message_type: "image",
    clientRequestId: "req-b",
    meta: { type: "image", imageUrl: "https://example.com/b.png", storagePath: "path/b.png" },
    timestamp: "2026-09-30T10:00:00.100Z", // 100ms later, closely adjacent
  };

  const result = canonicalizeChatMessages([imgA, imgB]);
  assert.equal(result.length, 2, "Different request IDs must NEVER be collapsed together");
  assert.equal(result[0].id, "img-turn-a");
  assert.equal(result[1].id, "img-turn-b");

  const collapsed = collapseAdjacentDuplicateChatMessages([imgA, imgB]);
  assert.equal(collapsed.length, 2, "Different request IDs must not be collapsed by adjacency either");
});

test("Test 5: [user(R1), image(R1), user(R1)] converges to 2 messages", () => {
  const retryUser = {
    id: `user-${R1}-retry`,
    role: "user",
    content: "Phuchka",
    clientRequestId: R1,
    timestamp: "2026-09-30T10:00:03.000Z",
  };

  const sequence = [LOCAL_USER_R1, LOCAL_IMAGE_R1, retryUser];
  const canonical = canonicalizeChatMessages(sequence);
  assert.equal(canonical.length, 2, `Expected 2 messages, got ${canonical.length}`);
  assert.equal(canonical[0].role, "user");
  assert.equal(canonical[1].role, "assistant");
});
