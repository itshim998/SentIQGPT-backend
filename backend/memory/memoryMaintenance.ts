import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "./memoryEmbedding";
import { updateMemoryEmbedding } from "../services/memoryService";

const MEMORY_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001";
const DEFAULT_BACKFILL_BATCH_SIZE = 2;
const MAX_BACKFILL_ATTEMPTS = 3;

type BackfillCandidate = {
  id?: string;
  summary?: string;
  importance?: number | null;
  embedding?: unknown;
  embedding_backfill_requested_at?: string | null;
};

type QueuedBackfillRow = {
  id: string;
  summary: string;
  embedding_backfill_attempts?: number | null;
};

function hasEmbedding(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export async function enqueueMemoryEmbeddingBackfill(
  userDb: SupabaseClient,
  userId: string,
  memories: readonly BackfillCandidate[],
  limit = 3,
): Promise<number> {
  const requestedAt = new Date().toISOString();
  const candidates = memories
    .filter((memory) => {
      if (!memory.id || !memory.summary) return false;
      if (hasEmbedding(memory.embedding)) return false;
      if ((memory.importance ?? 5) < 7) return false;
      return !memory.embedding_backfill_requested_at;
    })
    .slice(0, limit);

  let queued = 0;
  for (const memory of candidates) {
    const { error } = await userDb
      .from("memories")
      .update({
        embedding_backfill_requested_at: requestedAt,
        embedding_backfill_error: null,
      })
      .eq("id", memory.id)
      .eq("user_id", userId)
      .is("embedding", null);

    if (!error) {
      queued += 1;
    } else {
      console.warn(`[MEMORY MAINTENANCE] embedding backfill enqueue failed id=${memory.id} error=${error.message}`);
    }
  }

  return queued;
}

export async function processQueuedMemoryEmbeddingBackfill(
  userDb: SupabaseClient,
  userId: string,
  batchSize = DEFAULT_BACKFILL_BATCH_SIZE,
): Promise<{ processed: number; failed: number }> {
  const { data, error } = await userDb
    .from("memories")
    .select("id, summary, embedding_backfill_attempts")
    .eq("user_id", userId)
    .is("embedding", null)
    .not("embedding_backfill_requested_at", "is", null)
    .lt("embedding_backfill_attempts", MAX_BACKFILL_ATTEMPTS)
    .order("embedding_backfill_requested_at", { ascending: true })
    .limit(Math.max(1, Math.trunc(batchSize)));

  if (error) {
    console.warn(`[MEMORY MAINTENANCE] embedding backfill fetch failed userId=${userId} error=${error.message}`);
    return { processed: 0, failed: 1 };
  }

  let processed = 0;
  let failed = 0;
  for (const row of (data ?? []) as QueuedBackfillRow[]) {
    const attempts = Math.max(0, row.embedding_backfill_attempts ?? 0) + 1;
    await userDb
      .from("memories")
      .update({
        embedding_backfill_attempts: attempts,
        embedding_backfill_last_attempt_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("user_id", userId);

    try {
      const embedding = await generateEmbedding(row.summary);
      if (!embedding) {
        throw new Error("Embedding service returned no vector");
      }

      const { error: updateError } = await updateMemoryEmbedding(
        userDb,
        row.id,
        userId,
        embedding,
        MEMORY_EMBEDDING_MODEL,
      );
      if (updateError) {
        throw updateError;
      }
      processed += 1;
    } catch (backfillError) {
      failed += 1;
      await userDb
        .from("memories")
        .update({
          embedding_backfill_error: truncateError(backfillError),
          embedding_backfill_requested_at: attempts >= MAX_BACKFILL_ATTEMPTS ? null : new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("user_id", userId);
      console.warn(`[MEMORY MAINTENANCE] embedding backfill failed id=${row.id} error=${truncateError(backfillError)}`);
    }
  }

  return { processed, failed };
}
