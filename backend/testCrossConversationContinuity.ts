import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CROSS_CONVERSATION_CONTINUITY_SCHEMA_VERSION,
  fetchCrossConversationContinuity,
  formatCrossConversationContinuityForPrompt,
  normalizeCrossConversationContinuity,
  shouldSearchCrossConversationContinuity,
} from "./services/contextContinuityService";
import { buildChatPrompt } from "./ai/PromptBuilders";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const CURRENT_CONVERSATION = "20000000-0000-4000-8000-000000000001";

function payload() {
  return {
    schema_version: 1,
    stable_user_capsule: {
      provenance_kind: "memory",
      supports_saved_fact: true,
      supports_exact_claim: false,
      facts: [{
        memory_id: "30000000-0000-4000-8000-000000000001",
        summary: "The user is building SentIQ Chat.",
        fact_type: "stable_identity",
        subject_key: "identity:project_role",
        importance: 9,
        confidence: 0.9,
      }],
    },
    project_capsules: [{
      capsule_id: "40000000-0000-4000-8000-000000000001",
      conversation_id: "50000000-0000-4000-8000-000000000001",
      conversation_title: "SentIQ latency work",
      content: "Wave 0 attributed first-token latency and the next task is speculative provider generation.",
      project_key: "sentiq-latency",
      entity_keys: ["sentiq", "latency"],
      version: 4,
      retrieval_rank: 12,
      provenance_kind: "capsule",
      supports_exact_claim: false,
    }],
    unresolved_work: [{
      memory_id: "60000000-0000-4000-8000-000000000001",
      summary: "Test speculative provider generation without changing answer quality.",
      fact_type: "unresolved_commitment",
      importance: 9,
      provenance_kind: "memory",
      supports_saved_fact: true,
      supports_exact_claim: false,
    }],
    source_evidence: [{
      message_id: "70000000-0000-4000-8000-000000000001",
      conversation_id: "50000000-0000-4000-8000-000000000001",
      conversation_title: "SentIQ latency work",
      role: "assistant",
      content: "The decision was to preserve minReplicas at zero.",
      content_truncated: false,
      created_at: "2026-08-03T12:00:00.000Z",
      lexical_rank: 0.8,
      provenance_kind: "source_message",
      supports_exact_claim: true,
    }],
  };
}

async function main(): Promise<void> {
  assert.equal(shouldSearchCrossConversationContinuity("continue the SentIQ latency work"), true);
  assert.equal(shouldSearchCrossConversationContinuity("where were we with the PDF system"), true);
  assert.equal(shouldSearchCrossConversationContinuity("Do you remember the rollout decision?"), true);
  assert.equal(shouldSearchCrossConversationContinuity("hello"), false);
  assert.equal(shouldSearchCrossConversationContinuity("write a poem"), false);

  const normalized = normalizeCrossConversationContinuity(payload());
  assert.equal(normalized.schemaVersion, CROSS_CONVERSATION_CONTINUITY_SCHEMA_VERSION);
  assert.equal(normalized.projectCapsules.length, 1);
  assert.equal(normalized.projectCapsules[0].supportsExactClaim, false);
  assert.equal(normalized.sourceEvidence[0].supportsExactClaim, true);
  assert.equal(normalized.sourceEvidence[0].role, "assistant");
  assert.equal(normalized.stableFacts.length, 1);
  assert.equal(normalized.unresolvedWork.length, 1);

  const promptBlock = formatCrossConversationContinuityForPrompt(normalized);
  assert.match(promptBlock || "", /STABLE USER CAPSULE/i);
  assert.match(promptBlock || "", /broad continuity only/i);
  assert.match(promptBlock || "", /not evidence of exact prior wording/i);
  assert.match(promptBlock || "", /UNRESOLVED WORK RECORDS/i);

  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const result = await fetchCrossConversationContinuity({
    userDb: {
      rpc: async (name: string, params: Record<string, unknown>) => {
        calls.push({ name, params });
        return { data: payload(), error: null };
      },
    },
    ownerUserId: USER_ID,
    currentConversationId: CURRENT_CONVERSATION,
    query: "continue the SentIQ latency work",
  });
  assert.equal(result.status, "available");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "search_cross_conversation_context");
  assert.equal(calls[0].params.p_project_limit, 3);
  assert.equal(calls[0].params.p_current_conversation_id, CURRENT_CONVERSATION);

  const skipped = await fetchCrossConversationContinuity({
    userDb: { rpc: async () => { throw new Error("must not run"); } },
    ownerUserId: USER_ID,
    query: "hello",
  });
  assert.equal(skipped.status, "skipped");

  const chatPrompt = buildChatPrompt({
    userMessage: "continue the SentIQ latency work",
    workspaceCapsule: promptBlock,
    priorConversationEvidence: [{
      content: "The decision was to preserve minReplicas at zero.",
      createdAt: "2026-08-03T12:00:00.000Z",
    }],
  });
  assert.match(chatPrompt.prompt, /PROJECT CAPSULE 1/i);
  assert.match(chatPrompt.prompt, /PRIOR CONVERSATION EVIDENCE/i);
  assert.match(chatPrompt.prompt, /Saved memory is not transcript evidence/i);

  const migration = readFileSync(resolve(
    process.cwd(),
    "supabase/migrations/20260805220000_add_cross_conversation_continuity.sql",
  ), "utf8");
  assert.match(migration, /conversations_title_continuity_fts_idx/);
  assert.match(migration, /messages_continuity_fts_idx/);
  assert.match(migration, /context_capsules_continuity_search_gin_idx/);
  assert.match(migration, /role = 'assistant'/);
  assert.match(migration, /supports_exact_claim/);
  assert(!/embedding/i.test(
    migration.slice(
      migration.indexOf("create or replace function public.search_cross_conversation_context"),
      migration.indexOf("revoke all on function public.normalize_continuity_key"),
    ),
  ), "continuity retrieval must not generate or compare embeddings");

  const fastCompatibility = readFileSync(resolve(
    process.cwd(),
    "supabase/migrations/20260805220150_preserve_fast_snapshot_contract.sql",
  ), "utf8");
  assert.match(fastCompatibility, /schema_version', 2/);
  assert.match(fastCompatibility, /SELECTED CROSS-CONVERSATION CONTINUITY/);
  assert.match(fastCompatibility, /get_fast_context_snapshot_phase6_internal/);

  console.log("Phase 6 cross-conversation continuity unit contracts passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
