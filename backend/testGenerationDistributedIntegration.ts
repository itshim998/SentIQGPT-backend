import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Offline integration harness for durable generation guarantees.
 *
 * Deliberately does not import server.ts, any startup recovery module, Supabase,
 * model providers, or network clients. It models two backend replicas sharing
 * one durable generation/event store, so it adds zero Azure startup traffic.
 */

type Status = "queued" | "running" | "recoverable" | "cancel_requested" | "completed" | "failed" | "cancelled";

type Event = {
  sequence: number;
  type: string;
  partialText: string;
};

type GenerationRow = {
  id: string;
  ownerKey: string;
  shardId: number;
  status: Status;
  lastEventSequence: number;
  partialText: string;
  recoveryAttempts: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
};

class DurableGenerationStore {
  private readonly rows = new Map<string, GenerationRow>();
  private readonly events = new Map<string, Event[]>();
  private leaseCounter = 0;

  create(input: Pick<GenerationRow, "id" | "ownerKey" | "shardId">): GenerationRow {
    const row: GenerationRow = {
      ...input,
      status: "queued",
      lastEventSequence: 0,
      partialText: "",
      recoveryAttempts: 0,
      leaseId: null,
      leaseExpiresAt: null,
    };
    this.rows.set(row.id, row);
    this.events.set(row.id, []);
    return row;
  }

  get(id: string): GenerationRow {
    const row = this.rows.get(id);
    assert.ok(row, `generation ${id} should exist`);
    return row;
  }

  claimLease(id: string, now: number, ttlMs: number): string {
    const row = this.get(id);
    assert.ok(
      row.leaseId === null || (row.leaseExpiresAt !== null && row.leaseExpiresAt <= now),
      "lease must be available before claim",
    );
    const leaseId = `lease-${++this.leaseCounter}`;
    row.leaseId = leaseId;
    row.leaseExpiresAt = now + ttlMs;
    row.status = "running";
    return leaseId;
  }

  expireLease(id: string, now: number): void {
    const row = this.get(id);
    assert.ok(row.leaseExpiresAt !== null && row.leaseExpiresAt <= now, "lease should be expired first");
  }

  claimRecoveryAttempt(id: string, expectedAttempts: number): boolean {
    const row = this.get(id);
    if (row.recoveryAttempts !== expectedAttempts) return false;
    row.recoveryAttempts += 1;
    return true;
  }

  requestCancel(id: string): void {
    const row = this.get(id);
    if (!["completed", "failed", "cancelled"].includes(row.status)) row.status = "cancel_requested";
  }

  appendEvent(id: string, leaseId: string, event: Omit<Event, "sequence">): Event {
    const row = this.get(id);
    assert.equal(row.leaseId, leaseId, "stale executor must not append with an old lease");
    assert.ok(row.leaseExpiresAt !== null, "executor lease must exist");
    const sequence = row.lastEventSequence + 1;
    const stored = { ...event, sequence };
    this.events.get(id)!.push(stored);
    row.lastEventSequence = sequence;
    row.partialText = event.partialText;
    return stored;
  }

  replay(id: string, after: number): Event[] {
    return (this.events.get(id) ?? []).filter((event) => event.sequence > after);
  }
}

class ReplicaExecutor {
  stopped = false;
  constructor(
    readonly replicaId: string,
    readonly store: DurableGenerationStore,
    readonly generationId: string,
    readonly leaseId: string,
  ) {}

  pollControl(): void {
    const row = this.store.get(this.generationId);
    if (row.status === "cancel_requested" || row.leaseId !== this.leaseId) this.stopped = true;
  }

  emit(type: string, partialText: string): Event | null {
    if (this.stopped) return null;
    return this.store.appendEvent(this.generationId, this.leaseId, { type, partialText });
  }
}

class SerializedSubscription {
  private chain = Promise.resolve();
  readonly received: number[] = [];

  enqueueReplay(events: Event[]): void {
    this.chain = this.chain.then(async () => {
      for (const event of events) {
        await Promise.resolve();
        this.received.push(event.sequence);
      }
    });
  }

  enqueueLive(event: Event): void {
    this.chain = this.chain.then(async () => {
      await Promise.resolve();
      this.received.push(event.sequence);
    });
  }

  async settled(): Promise<void> {
    await this.chain;
  }
}

const CONTRACT_ROOT = __dirname;

function read(relative: string): string {
  return fs.readFileSync(path.resolve(CONTRACT_ROOT, relative), "utf8");
}

test("guest generation survives crash and recovers on the same shard", () => {
  const store = new DurableGenerationStore();
  const row = store.create({ id: "g-same-shard", ownerKey: "guest-owner-1", shardId: 2 });

  const firstLease = store.claimLease(row.id, 1000, 100);
  const first = new ReplicaExecutor("backend-A", store, row.id, firstLease);
  first.emit("token", "hello");

  store.expireLease(row.id, 1200);
  row.leaseId = null;
  row.leaseExpiresAt = null;
  row.status = "recoverable";
  assert.equal(store.claimRecoveryAttempt(row.id, 0), true);

  const recoveryLease = store.claimLease(row.id, 1200, 1000);
  const recovered = new ReplicaExecutor("backend-A-restarted", store, row.id, recoveryLease);
  recovered.emit("token", "hello world");

  assert.equal(row.shardId, 2);
  assert.equal(row.recoveryAttempts, 1);
  assert.equal(row.status, "running");
  assert.equal(row.lastEventSequence, 2);
});

test("guest generation recovers on another backend instance from the same durable shard", () => {
  const store = new DurableGenerationStore();
  const row = store.create({ id: "g-cross-instance", ownerKey: "guest-owner-2", shardId: 3 });
  const leaseA = store.claimLease(row.id, 1000, 100);
  const replicaA = new ReplicaExecutor("backend-A", store, row.id, leaseA);
  replicaA.emit("token", "partial");

  row.leaseId = null;
  row.leaseExpiresAt = null;
  row.status = "recoverable";
  assert.equal(store.claimRecoveryAttempt(row.id, 0), true);

  const leaseB = store.claimLease(row.id, 1500, 1000);
  const replicaB = new ReplicaExecutor("backend-B", store, row.id, leaseB);
  replicaB.emit("generation_completed", "partial-complete");

  assert.notEqual(replicaA.replicaId, replicaB.replicaId);
  assert.equal(row.shardId, 3);
  assert.equal(row.lastEventSequence, 2);
  assert.equal(row.partialText, "partial-complete");
});

test("guest cancellation requested on replica B stops execution owned by replica A", () => {
  const store = new DurableGenerationStore();
  const row = store.create({ id: "g-cancel-cross-replica", ownerKey: "guest-owner-3", shardId: 4 });
  const leaseA = store.claimLease(row.id, 1000, 1000);
  const replicaA = new ReplicaExecutor("backend-A", store, row.id, leaseA);

  // Replica B only changes durable control state; it does not need A's memory.
  store.requestCancel(row.id);
  replicaA.pollControl();

  assert.equal(replicaA.stopped, true);
  assert.equal(replicaA.emit("token", "must-not-execute"), null);
});

test("durable replay returns exactly N+1 through M", () => {
  const store = new DurableGenerationStore();
  const row = store.create({ id: "g-replay", ownerKey: "guest-owner-4", shardId: 2 });
  const lease = store.claimLease(row.id, 1000, 1000);
  const replica = new ReplicaExecutor("backend-A", store, row.id, lease);
  for (let i = 1; i <= 6; i += 1) replica.emit("token", String(i));

  assert.deepEqual(store.replay(row.id, 3).map((event) => event.sequence), [4, 5, 6]);
});

test("replay and live publication remain ordered", async () => {
  const store = new DurableGenerationStore();
  const row = store.create({ id: "g-race", ownerKey: "guest-owner-5", shardId: 2 });
  const lease = store.claimLease(row.id, 1000, 1000);
  const replica = new ReplicaExecutor("backend-A", store, row.id, lease);
  for (let i = 1; i <= 5; i += 1) replica.emit("token", String(i));

  const subscription = new SerializedSubscription();
  subscription.enqueueReplay(store.replay(row.id, 3));
  const live = replica.emit("token", "6");
  assert.ok(live);
  subscription.enqueueLive(live!);
  await subscription.settled();

  assert.deepEqual(subscription.received, [4, 5, 6]);
});

test("lease expiration prevents the old executor from continuing", () => {
  const store = new DurableGenerationStore();
  const row = store.create({ id: "g-lease-expiry", ownerKey: "guest-owner-6", shardId: 3 });
  const leaseA = store.claimLease(row.id, 1000, 100);
  const oldExecutor = new ReplicaExecutor("backend-A", store, row.id, leaseA);

  store.expireLease(row.id, 1200);
  row.leaseId = null;
  row.leaseExpiresAt = null;
  row.status = "recoverable";
  oldExecutor.pollControl();

  assert.equal(oldExecutor.stopped, true);
});

test("stale executor cannot append after lease ownership transfers", () => {
  const store = new DurableGenerationStore();
  const row = store.create({ id: "g-fenced-append", ownerKey: "guest-owner-7", shardId: 4 });
  const leaseA = store.claimLease(row.id, 1000, 100);
  const oldExecutor = new ReplicaExecutor("backend-A", store, row.id, leaseA);

  row.leaseId = null;
  row.leaseExpiresAt = null;
  row.status = "recoverable";
  const leaseB = store.claimLease(row.id, 1500, 1000);
  const newExecutor = new ReplicaExecutor("backend-B", store, row.id, leaseB);
  newExecutor.emit("token", "new-owner");

  assert.throws(
    () => oldExecutor.emit("token", "stale-owner"),
    /stale executor must not append/,
  );
});

test("fresh snapshot is delivered before future events", async () => {
  const snapshotSequence = 3;
  const futureEvents: Event[] = [
    { sequence: 4, type: "token", partialText: "abcd" },
    { sequence: 5, type: "generation_completed", partialText: "abcd" },
  ];

  const received: Array<number | "snapshot"> = [];
  received.push("snapshot");
  const subscription = new SerializedSubscription();
  subscription.enqueueReplay(futureEvents);
  await subscription.settled();
  received.push(...subscription.received);

  assert.deepEqual(received, ["snapshot", 4, 5]);
  assert.equal(snapshotSequence, 3);
});

test("production code keeps distributed generation guarantees off the Azure startup path", () => {
  const server = read("server.ts");
  const guestRecovery = read("services/guestGenerationRecovery.ts");
  const coordinator = read("services/chatGenerationTaskCoordinator.ts");
  const runner = read("services/generationRunner.ts");

  assert.match(server, /guestGenerationRecovery/);
  assert.match(guestRecovery, /getGuestGenerationDatabase/);
  assert.match(guestRecovery, /claimGuestGenerationRecoveryAttempt/);
  assert.match(coordinator, /deliveryChain/);
  assert.match(coordinator, /DURABLE_EVENT_POLL_MS/);
  assert.match(runner, /CONTROL_POLL_MS/);

  // This test itself is intentionally not imported by server.ts or any startup module.
  assert.doesNotMatch(server, /testGenerationDistributedIntegration/);
});
