import assert from "assert/strict";
import { buildChatPrompt } from "./ai/PromptBuilders";
import {
  getMirroredUserProfile,
  saveMirroredUserProfile,
  validateDisplayName,
} from "./services/profileService";

type MockUserRow = {
  display_name?: string | null;
  display_name_updated_at?: string | null;
};

class MockProfileDb {
  readonly rows = new Map<string, MockUserRow>();
  readonly updates: Array<{ userId: string; values: MockUserRow }> = [];

  from(table: string) {
    assert.equal(table, "users", "profile service should only query the users table");

    return {
      select: (_columns: string) => ({
        eq: (_column: string, userId: string) => ({
          maybeSingle: async () => ({
            data: this.rows.get(userId) ?? null,
            error: null,
          }),
        }),
      }),
      update: (values: MockUserRow) => ({
        eq: async (_column: string, userId: string) => {
          this.updates.push({ userId, values });
          const current = this.rows.get(userId) ?? {};
          this.rows.set(userId, {
            ...current,
            ...values,
          });
          return { error: null };
        },
      }),
    };
  }
}

async function main(): Promise<void> {
  const userId = "11111111-1111-4111-8111-111111111111";

  assert.equal(validateDisplayName("  Ada   Lovelace  "), "Ada Lovelace", "normalizes whitespace in display names");
  assert.throws(() => validateDisplayName("   "), /Display name is required\./, "rejects blank display names");
  assert.throws(
    () => validateDisplayName("x".repeat(81)),
    /Display name must be 1-80 characters\./,
    "rejects names longer than 80 characters",
  );

  const controlDb = new MockProfileDb();
  const shardDb = new MockProfileDb();
  controlDb.rows.set(userId, { display_name: null });
  shardDb.rows.set(userId, { display_name: null });

  const saved = await saveMirroredUserProfile({
    userId,
    displayName: "  Maya   Chen  ",
    controlDb,
    userDb: shardDb,
  });

  assert.equal(saved.displayName, "Maya Chen", "save returns normalized display name");
  assert.equal(controlDb.rows.get(userId)?.display_name, "Maya Chen", "control DB mirrors saved display name");
  assert.equal(shardDb.rows.get(userId)?.display_name, "Maya Chen", "assigned shard mirrors saved display name");

  const fallbackControlDb = new MockProfileDb();
  const fallbackShardDb = new MockProfileDb();
  fallbackControlDb.rows.set(userId, { display_name: "Maya Chen" });
  fallbackShardDb.rows.set(userId, { display_name: null });

  const mirrored = await getMirroredUserProfile({
    userId,
    controlDb: fallbackControlDb,
    userDb: fallbackShardDb,
  });

  assert.equal(mirrored.displayName, "Maya Chen", "profile read falls back to control DB when shard is missing");
  assert.equal(mirrored.requiresName, false, "fallback profile does not require a name");
  assert.equal(mirrored.source, "control", "control DB is recorded as the source for the fallback read");
  assert.equal(mirrored.repaired.shard, true, "missing shard mirror is repaired opportunistically");
  assert.equal(fallbackShardDb.rows.get(userId)?.display_name, "Maya Chen", "fallback read repaired the shard mirror");

  const prompt = buildChatPrompt({
    userMessage: "Summarize the uploaded brief and tell me what's next.",
    trustedProfile: { displayName: "Maya Chen" },
    fileReferences: [{ filename: "brief.txt", extractedText: "Timeline, risks, and next steps." }],
  });

  assert.match(prompt.prompt, /STABLE USER CONTEXT:/, "chat prompt includes trusted profile context after stable rules");
  assert.match(prompt.prompt, /Maya Chen/, "chat prompt injects the saved display name");
  assert.match(prompt.prompt, /FILE ANALYSIS MODE:/, "profile injection still works for file-mode prompts");

  console.log("PASS | profile validation, mirroring, fallback repair, and prompt personalization passed.");
}

main().catch((error) => {
  console.error("FAIL | profile flow regression tests failed.");
  console.error(error);
  process.exit(1);
});
