import assert from "node:assert/strict";
import test from "node:test";
import dotenv from "dotenv";

dotenv.config();
for (const id of [1, 2, 3]) {
  process.env[`SUPABASE_URL_${id}`] ??= `https://shard-${id}-test.supabase.co`;
  process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ??= `test-key-${id}`;
}

async function runTests(): Promise<void> {
  const {
    ASSIGNABLE_DATABASE_IDS,
    selectLeastLoadedDatabaseFromCounts,
    getClientForDatabase,
  } = await import("./dbRouter");

  await test("Two Data Shard Topology (DB1 Control, DB2 Shard 1, DB3 Shard 2)", async (t) => {
    await t.test("Assignable shards are strictly DB2 and DB3", () => {
      assert.deepEqual(ASSIGNABLE_DATABASE_IDS, [2, 3]);
    });

    await t.test("getClientForDatabase accepts 1, 2, 3 and throws on 4", () => {
      assert.ok(getClientForDatabase(1));
      assert.ok(getClientForDatabase(2));
      assert.ok(getClientForDatabase(3));
      assert.throws(
        () => getClientForDatabase(4 as any),
        /Invalid assigned_db value "4" in control database/,
      );
    });

    await t.test("selectLeastLoadedDatabase selects between DB2 and DB3 only", () => {
      const counts1 = new Map<any, number>([
        [2, 100],
        [3, 50],
      ]);
      assert.equal(selectLeastLoadedDatabaseFromCounts(counts1, () => 0), 3);

      const counts2 = new Map<any, number>([
        [2, 20],
        [3, 80],
      ]);
      assert.equal(selectLeastLoadedDatabaseFromCounts(counts2, () => 0), 2);
    });

    await t.test("Guest owner keys are isolated from shard router", async () => {
      const { guestGenerationOwnerKeyFromAnonymousId } = await import("./services/guestGenerationIdentity");
      const key1 = guestGenerationOwnerKeyFromAnonymousId("guest-test-key-1");
      const key2 = guestGenerationOwnerKeyFromAnonymousId("guest-test-key-1");
      assert.equal(key1, key2);
      assert.equal(typeof key1, "string");
      assert.equal(key1.length, 64);
    });
  });
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
