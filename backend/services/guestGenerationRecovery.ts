import { chatGenerationTaskCoordinator } from "./chatGenerationTaskCoordinator";
import {
  claimGuestGenerationRecoveryAttempt,
  getGuestGenerationDatabase,
  recordGuestGenerationRecoveryFailure,
} from "./guestGenerationStore";
import { runGeneration } from "./generationRunner";

type GuestGenerationRecoveryRow = {
  id: string;
  conversation_id: string | null;
  user_id: string;
  client_request_id: string | null;
  generation_session_id: string | null;
  status: string;
  execution_mode: "fast" | "intuitive" | null;
  model_route: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  error_code: string | null;
  partial_text: string;
  tokens_generated: number;
  last_event_sequence: number;
  created_at: string;
  updated_at: string;
  execution_snapshot: Record<string, unknown>;
  execution_lease_id: string | null;
  execution_lease_expires_at: string | null;
  recovery_attempts: number;
  last_execution_error: string | null;
};

const STALE_EXECUTION_MS = 75_000;
const RECOVERY_START_DELAY_MS = 1_700;
const MAX_RECOVERY_ATTEMPTS = 5;
let started = false;

function shouldRecover(row: GuestGenerationRecoveryRow, nowMs: number): boolean {
  if (["queued", "recoverable", "cancel_requested"].includes(row.status)) return true;
  if (!["running", "waiting_for_tool", "generating", "persisting"].includes(row.status)) return false;
  const leaseExpires = row.execution_lease_expires_at ? Date.parse(row.execution_lease_expires_at) : NaN;
  const updatedAt = Date.parse(row.updated_at || "");
  return (!Number.isFinite(leaseExpires) || leaseExpires <= nowMs)
    && (!Number.isFinite(updatedAt) || updatedAt <= nowMs - STALE_EXECUTION_MS);
}

async function recoverShard(
  db: ReturnType<typeof getGuestGenerationDatabase>,
  row: GuestGenerationRecoveryRow,
): Promise<void> {
  if (row.recovery_attempts >= MAX_RECOVERY_ATTEMPTS) return;

  const attempt = await claimGuestGenerationRecoveryAttempt(
    db,
    row.user_id,
    row.id,
    row.recovery_attempts,
  );
  if (attempt.error) return;
  if (!attempt.claimed) return;

  const task = chatGenerationTaskCoordinator.start({
    generationId: row.id,
    clientRequestId: row.client_request_id,
    generationSessionId: row.generation_session_id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    userDb: db,
    generation: row as any,
    liveExecutionSnapshot: undefined,
  });
  if (task.runPromise || task.terminal) return;

  try {
    await runGeneration(row.id);
  } catch (error) {
    const message = String((error as any)?.code || "guest_generation_recovery_failed");
    await recordGuestGenerationRecoveryFailure(db, row.user_id, row.id, message).catch(() => undefined);
    await chatGenerationTaskCoordinator.failed(row.id, message).catch(() => undefined);
  }
}

export async function recoverStaleGuestGenerations(): Promise<void> {
  if (started) return;
  started = true;
  const nowMs = Date.now();
  const shardDatabases = [2, 3];
  for (const databaseId of shardDatabases) {
    try {
      const { getDataShardDatabases } = await import("../dbRouter");
      const baseDb = getDataShardDatabases()[databaseId - 2];
      const result = await baseDb
        .from("guest_chat_generations")
        .select("id, conversation_id, user_id, client_request_id, generation_session_id, status, execution_mode, model_route, started_at, completed_at, failed_at, cancelled_at, error_code, partial_text, tokens_generated, last_event_sequence, created_at, updated_at, execution_snapshot, execution_lease_id, execution_lease_expires_at, recovery_attempts, last_execution_error")
        .in("status", ["queued", "running", "recoverable", "cancel_requested", "waiting_for_tool", "generating", "persisting"])
        .order("updated_at", { ascending: true })
        .limit(200);
      if (result.error) continue;
      for (const raw of result.data || []) {
        const row = raw as GuestGenerationRecoveryRow;
        if (!shouldRecover(row, nowMs)) continue;
        void recoverShard(getGuestGenerationDatabase(row.user_id), row);
      }
    } catch {
      // A single shard being unavailable must not prevent recovery on the others.
    }
  }
}

setTimeout(() => { void recoverStaleGuestGenerations(); }, RECOVERY_START_DELAY_MS).unref?.();
