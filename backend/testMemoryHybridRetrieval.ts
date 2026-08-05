import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fuseMemoryRetrieval, type HybridMemoryCandidate } from "./memory/hybridRetrieval";
import type { SemanticSearchResult } from "./memory/semanticSearch";

const candidates: HybridMemoryCandidate[] = [
  {
    id: "exact",
    type: "project",
    summary: "Project Aster uses a deterministic recovery queue.",
    importance: 8,
    subject_key: "project:aster",
    fact_type: "active_project_state",
    exact_phrase_match: true,
    entity_or_project_match: true,
    lexical_rank: 0.9,
    retrieval_rank: 130,
    status: "active",
  },
  {
    id: "semantic",
    type: "project",
    summary: "The failover watcher delegates interrupted requests.",
    importance: 7,
    subject_key: "project:failover",
    fact_type: "active_project_state",
    lexical_rank: 0.01,
    retrieval_rank: 7,
    status: "active",
  },
  {
    id: "identity",
    type: "identity",
    summary: "The user is a B.Tech AI and ML student.",
    importance: 9,
    subject_key: "identity:education_or_role",
    fact_type: "stable_identity",
    anchor_rank: 1,
    status: "active",
  },
  {
    id: "chat",
    type: "project",
    summary: "The next step is to verify the production migration.",
    importance: 8,
    subject_key: "project:migration-next-step",
    fact_type: "unresolved_commitment",
    scope: "chat",
    chat_id: "conversation-1",
    status: "active",
  },
  {
    id: "superseded",
    type: "preference",
    summary: "The user prefers concise answers.",
    importance: 9,
    subject_key: "preference:response_length",
    fact_type: "stable_preference",
    exact_phrase_match: true,
    status: "superseded",
  },
  {
    id: "active-preference",
    type: "preference",
    summary: "The user now prefers detailed answers.",
    importance: 9,
    subject_key: "preference:response_length",
    fact_type: "stable_preference",
    status: "active",
  },
];

const semanticResults: SemanticSearchResult[] = [
  { memory: candidates[1], similarity: 0.93 },
  { memory: candidates[5], similarity: 0.88 },
];

const fused = fuseMemoryRetrieval({
  candidates,
  semanticResults,
  query: "What does Project Aster use?",
  conversationId: "conversation-1",
  limit: 6,
});

assert.equal(fused[0]?.id, "exact", "exact lexical match must remain first after fusion");
assert.ok(fused.some((memory) => memory.id === "semantic"), "semantic match must be unioned");
assert.ok(fused.some((memory) => memory.id === "identity"), "identity anchor must be unioned");
assert.ok(fused.some((memory) => memory.id === "chat"), "active-chat memory must be unioned");
assert.ok(!fused.some((memory) => memory.id === "superseded"), "superseded memory must be excluded");
assert.equal(
  fused.filter((memory) => memory.subject_key === "preference:response_length").length,
  1,
  "diversity must keep one active memory per subject",
);
assert.ok(
  fused.find((memory) => memory.id === "exact")?.retrieval_sources.includes("exact"),
  "exact source attribution must survive RRF",
);
assert.ok(
  fused.find((memory) => memory.id === "semantic")?.retrieval_sources.includes("semantic"),
  "semantic source attribution must survive RRF",
);

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260805150000_improve_memory_hybrid_retrieval.sql"),
  "utf8",
);
const guardMigration = readFileSync(
  resolve(root, "supabase/migrations/20260805150050_guard_direct_memory_writes.sql"),
  "utf8",
);
const fastMigration = readFileSync(
  resolve(root, "supabase/migrations/20260805150100_upgrade_fast_memory_snapshot.sql"),
  "utf8",
);
const contextBuilder = readFileSync(resolve(root, "backend/context/contextBuilder.ts"), "utf8");
const fastSnapshotService = readFileSync(resolve(root, "backend/services/fastContextSnapshotService.ts"), "utf8");
const memoryService = readFileSync(resolve(root, "backend/services/memoryService.ts"), "utf8");
const memoryProcessor = readFileSync(resolve(root, "backend/ai/MemoryProcessor.ts"), "utf8");
const hybridRetrieval = readFileSync(resolve(root, "backend/memory/hybridRetrieval.ts"), "utf8");
const phase5Verifier = readFileSync(resolve(root, "backend/verifyPhase5MigrationState.sql"), "utf8");

assert.match(migration, /add column if not exists search_vector tsvector/i);
assert.match(migration, /using gin\(search_vector\)/i);
assert.match(migration, /create or replace function public\.search_memories_lexical/i);
assert.match(migration, /exact_phrase_match boolean/i);
assert.match(migration, /entity_or_project_match boolean/i);
assert.match(migration, /subject_key text/i);
assert.match(migration, /supersedes_memory_id uuid/i);
assert.match(migration, /status text not null default 'active'/i);
assert.match(migration, /last_confirmed_at timestamptz/i);
assert.match(migration, /stable_identity/i);
assert.match(migration, /unresolved_commitment/i);
assert.match(migration, /temporary_condition/i);
assert.match(migration, /pg_advisory_xact_lock/i);
assert.match(migration, /set status = 'superseded'/i);
assert.match(guardMigration, /before insert or update/i);
assert.match(fastMigration, /search_memories_lexical/i);
assert.match(fastMigration, /'schema_version', 2/i);

assert.match(contextBuilder, /searchUserMemoriesLexically\(/);
assert.match(contextBuilder, /semanticMemorySearch\(memoryCandidates/);
assert.match(contextBuilder, /fuseMemoryRetrieval\(/);
assert.doesNotMatch(contextBuilder, /memory retrieval: keyword fallback/);
assert.doesNotMatch(contextBuilder, /enqueueMemoryEmbeddingBackfill/);
assert.doesNotMatch(contextBuilder, /processQueuedMemoryEmbeddingBackfill/);
assert.doesNotMatch(contextBuilder, /memoryMaintenance/);
assert.match(contextBuilder, /subject_key: memory\.subjectKey/);
assert.match(contextBuilder, /exact_phrase_match: memory\.exactPhraseMatch/);
assert.match(fastSnapshotService, /FAST_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 2/);
assert.match(fastSnapshotService, /exactPhraseMatch/);
assert.match(fastSnapshotService, /subjectKey/);
assert.match(memoryService, /persist_memory_with_lifecycle/);
assert.match(memoryService, /\.eq\("status", "active"\)/);
assert.match(memoryProcessor, /classification\.type === "knowledge"/);
assert.match(memoryProcessor, /knowledge_memory_skipped/);
assert.doesNotMatch(hybridRetrieval, /generateEmbedding/);
assert.doesNotMatch(memoryService, /generateEmbedding/);
assert.match(phase5Verifier, /phase5-migrations-verified/);
assert.match(phase5Verifier, /old_row\.status is distinct from new_row\.status/i);
assert.match(phase5Verifier, /from public\.search_source_chunks/i);

console.log("phase3-memory-hybrid-ok");
