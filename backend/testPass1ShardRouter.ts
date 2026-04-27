import assert from "assert/strict";
import type { AssignableDatabaseId } from "./dbRouter";

function setSupabaseTestEnv(): void {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ??= "https://test-project.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ??= "test-service-role-key";
  }
}

async function main(): Promise<void> {
  setSupabaseTestEnv();
  const {
    SHARD_USER_CAPACITY,
    ShardCapacityError,
    selectLeastLoadedDatabaseFromCounts,
  } = await import("./dbRouter");

  const uniqueLeastLoadedCounts = new Map<AssignableDatabaseId, number>([
    [2, 12],
    [3, 4],
    [4, 9],
  ]);
  assert.equal(
    selectLeastLoadedDatabaseFromCounts(uniqueLeastLoadedCounts, () => 0),
    3,
    "selects the uniquely least-loaded shard",
  );

  const tiedCounts = new Map<AssignableDatabaseId, number>([
    [2, 5],
    [3, 7],
    [4, 5],
  ]);
  let observedTieCandidateCount = 0;
  const selectedTie = selectLeastLoadedDatabaseFromCounts(tiedCounts, (candidateCount) => {
    observedTieCandidateCount = candidateCount;
    return 1;
  });
  assert.equal(observedTieCandidateCount, 2, "only equally least-loaded shards are tie candidates");
  assert.equal(selectedTie, 4, "tie selector can choose among equally least-loaded shards");

  const fullCounts = new Map<AssignableDatabaseId, number>([
    [2, SHARD_USER_CAPACITY.assignmentThreshold],
    [3, SHARD_USER_CAPACITY.assignmentThreshold + 1],
    [4, SHARD_USER_CAPACITY.assignmentThreshold],
  ]);
  assert.throws(
    () => selectLeastLoadedDatabaseFromCounts(fullCounts, () => 0),
    (error) => {
      assert(error instanceof ShardCapacityError, "throws typed shard-capacity error");
      assert.equal(error.code, "shard_capacity_exhausted");
      assert.equal(error.retryAfterSeconds, 60);
      assert.equal(error.threshold, SHARD_USER_CAPACITY.assignmentThreshold);
      assert.equal(error.totalUsers, SHARD_USER_CAPACITY.assignmentThreshold * 3 + 1);
      return true;
    },
  );

  console.log("PASS | PASS 1 shard router regression tests passed.");
}

main().catch((error) => {
  console.error("FAIL | PASS 1 shard router regression tests failed.");
  console.error(error);
  process.exit(1);
});
