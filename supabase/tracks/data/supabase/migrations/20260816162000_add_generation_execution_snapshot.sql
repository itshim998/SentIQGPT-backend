-- SentIQ Chat — Phase 5/6: persist enough request state to restart a detached generation.
-- RUN ON: every data shard (Database 2, 3, 4).
--
-- The snapshot is bounded by the application before insertion. Large inline image
-- payloads are intentionally excluded from durable recovery snapshots.

alter table public.chat_generations
  add column if not exists execution_snapshot jsonb not null default '{}'::jsonb;

comment on column public.chat_generations.execution_snapshot is
  'Bounded, transport-independent generation request snapshot used to restart execution after process restart or transport loss.';