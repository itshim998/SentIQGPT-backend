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
  const { getGuestAssignedShardId } = await import("./services/guestGenerationStore");

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

    await t.test("Guest owner key hashing maps only to DB2 or DB3", () => {
      const assignedShards = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const shard = getGuestAssignedShardId(`guest-test-key-${i}`);
        assert.ok(shard === 2 || shard === 3, `Expected shard 2 or 3, got ${shard}`);
        assignedShards.add(shard);
      }
      assert.equal(assignedShards.size, 2, "Must distribute across both DB2 and DB3");
      assert.ok(!assignedShards.has(4), "Must NEVER assign DB4");
    });
  });
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
