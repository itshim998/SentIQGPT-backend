-- Durable memory embeddings for semantic recall
--
-- RUN ON: Database 2, 3, 4 (data shards only, NOT on Control DB 1)

alter table public.memories
add column if not exists embedding jsonb,
add column if not exists embedding_model text,
add column if not exists embedding_created_at timestamptz;

create index if not exists idx_memories_user_importance_embedding_backfill
  on public.memories (user_id, importance desc, created_at desc)
  where embedding is null;
