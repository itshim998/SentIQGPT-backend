-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
-- APPLY BEFORE:
--   20260805220000_add_cross_conversation_continuity.sql
--
-- PostgreSQL requires generated expressions to use only immutable functions.
-- array_to_string(text[], text) is not immutable, so Phase 6 stores the weighted
-- continuity vector in an ordinary column maintained by a deterministic trigger.

alter table public.context_capsules
  add column if not exists continuity_search_vector tsvector;

comment on column public.context_capsules.continuity_search_vector is
  'Trigger-maintained weighted FTS vector for cross-conversation capsule retrieval.';
