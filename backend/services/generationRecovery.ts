import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chatGenerationTaskCoordinator } from "./chatGenerationTaskCoordinator";
import {
  getChatGenerationById,
  markChatGenerationRecoverable,
  type ChatGenerationRow,
} from "./chatGenerationService";
import { runGeneration } from "./generationRunner";

const DATA_DATABASE_IDS = [2, 3] as const;
const STALE_EXECUTION_MS = 75_000;
const RECOVERY_START_DELAY_MS = 1_500;
const MAX_RECOVERY_ATTEMPTS = 5;
let recoveryStarted = false;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[GenerationRecovery] Missing ${name}`);
  return value;
}

function createShardClient(databaseId: number): SupabaseClient {
  return createClient(
    requiredEnv(`SUPABASE_URL_${databaseId}`),
    requiredEnv(`SUPABASE_SERVICE_ROLE_KEY_${databaseId}`),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function shouldRecover(row: any, nowMs: number): boolean {
  const status = String(row.status || "");
  if (!["queued", "recoverable", "running", "waiting_for_tool", "generating", "persisting"].includes(status)) return false;
  const updatedAt = Date.parse(row.updated_at || "");
  // Ignore abandoned generations older than 30 minutes
  if (Number.isFinite(updatedAt) && nowMs - updatedAt > 30 * 60 * 1000) return false;
  const leaseExpires = row.execution_lease_expires_at ? Date.parse(row.execution_lease_expires_at) : NaN;
  return (!Number.isFinite(leaseExpires) || leaseExpires <= nowMs)
    && (!Number.isFinite(updatedAt) || updatedAt <= nowMs - STALE_EXECUTION_MS);
}

async function recoverGeneration(userDb: SupabaseClient, row: ChatGenerationRow): Promise<void> {
  if (row.status !== "queued" && row.status !== "recoverable") {
    const marked = await markChatGenerationRecoverable(userDb, {
      userId: row.user_id,
      generationId: row.id,
      error: "backend_execution_lease_expired",
    });
    if (marked.error || !marked.data) return;
    row = marked.data;
  }

  if (row.recovery_attempts >= MAX_RECOVERY_ATTEMPTS) {
    console.error(`[GenerationRecovery] max recovery attempts reached generation=${row.id} user=${row.user_id}`);
    return;
  }

  const task = chatGenerationTaskCoordinator.start({
    generationId: row.id,
    clientRequestId: row.client_request_id,
    generationSessionId: row.generation_session_id,
    userId: row.user_id,
    userDb,
    generation: row,
  });
  if (task.runPromise || task.terminal) return;

  try {
    await runGeneration(row.id);
    console.log(`[GenerationRecovery] generation recovery started generation=${row.id} attempt=${row.recovery_attempts + 1}`);
  } catch (error) {
    await chatGenerationTaskCoordinator.failed(row.id, String((error as any)?.code || "generation_recovery_failed")).catch(() => undefined);
    console.warn(`[GenerationRecovery] recovery failed generation=${row.id} error=${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function recoverStaleGenerations(): Promise<void> {
  if (recoveryStarted) return;
  recoveryStarted = true;
  const nowMs = Date.now();

  for (const databaseId of DATA_DATABASE_IDS) {
    try {
      const { getDataShardDatabases } = await import("../dbRouter");
      const userDb = getDataShardDatabases()[databaseId - 2];
      if (!userDb) continue;
      const result = await userDb
        .from("chat_generations")
        .select("id, conversation_id, user_id, client_request_id, generation_session_id, status, execution_mode, model_route, started_at, completed_at, failed_at, cancelled_at, error_code, partial_text, tokens_generated, last_event_sequence, created_at, updated_at, execution_snapshot, execution_lease_id, execution_lease_expires_at, recovery_attempts, last_execution_error")
        .in("status", ["queued", "running", "recoverable", "waiting_for_tool", "generating", "persisting"])
        .order("updated_at", { ascending: false })
        .limit(10);
      if (result.error) {
        console.warn(`[GenerationRecovery] shard=${databaseId} scan failed: ${result.error.message}`);
        continue;
      }

      for (const raw of result.data || []) {
        if (!shouldRecover(raw, nowMs)) continue;
        const row = raw as ChatGenerationRow;
        await recoverGeneration(userDb, row).catch(() => undefined);
      }
    } catch (error) {
      console.warn(`[GenerationRecovery] shard=${databaseId} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

setTimeout(() => { void recoverStaleGenerations(); }, RECOVERY_START_DELAY_MS).unref?.();
