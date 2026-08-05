import { selectMemoriesForQuery } from "../context/memorySelector";
import type { SemanticSearchResult } from "./semanticSearch";

export type MemoryFactType =
  | "stable_identity"
  | "stable_preference"
  | "active_project_state"
  | "unresolved_commitment"
  | "temporary_condition";

export interface HybridMemoryCandidate {
  readonly id?: string;
  readonly type: string;
  readonly summary: string;
  readonly importance?: number;
  readonly embedding?: readonly number[];
  readonly scope?: "global" | "chat";
  readonly chat_id?: string | null;
  readonly created_at?: string;
  readonly subject_key?: string;
  readonly fact_type?: MemoryFactType | string;
  readonly last_confirmed_at?: string;
  readonly status?: "active" | "superseded" | string;
  readonly confidence?: number;
  readonly project_scope?: string | null;
  readonly temporal_scope?: string | null;
  readonly exact_phrase_match?: boolean;
  readonly entity_or_project_match?: boolean;
  readonly lexical_rank?: number;
  readonly retrieval_rank?: number;
  readonly anchor_rank?: number;
  readonly relevance?: number;
}

export interface FusedMemoryCandidate extends HybridMemoryCandidate {
  readonly relevance: number;
  readonly retrieval_sources: readonly string[];
}

const RRF_K = 60;
const EXACT_WEIGHT = 3.5;
const LEXICAL_WEIGHT = 1.8;
const SEMANTIC_WEIGHT = 1.35;
const ANCHOR_WEIGHT = 0.85;
const ACTIVE_CHAT_WEIGHT = 0.9;

function normalizedSummary(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function memoryIdentity(memory: HybridMemoryCandidate): string {
  if (memory.id) return `id:${memory.id}`;
  return `summary:${normalizedSummary(memory.summary)}`;
}

function rankContribution(rank: number, weight: number): number {
  return weight / (RRF_K + Math.max(1, rank));
}

function isHighImportanceAnchor(memory: HybridMemoryCandidate): boolean {
  if ((memory.importance ?? 5) < 8) return false;
  return [
    "stable_identity",
    "stable_preference",
    "active_project_state",
    "unresolved_commitment",
  ].includes(memory.fact_type ?? "") || ["identity", "preference", "project"].includes(memory.type);
}

function isActiveChatMemory(memory: HybridMemoryCandidate, conversationId?: string): boolean {
  return Boolean(
    conversationId &&
    memory.scope === "chat" &&
    memory.chat_id === conversationId,
  );
}

function lexicalOrder(
  candidates: readonly HybridMemoryCandidate[],
  query: string,
): readonly HybridMemoryCandidate[] {
  const databaseRanked = [...candidates].sort((left, right) => {
    if (Boolean(left.exact_phrase_match) !== Boolean(right.exact_phrase_match)) {
      return left.exact_phrase_match ? -1 : 1;
    }
    if (Boolean(left.entity_or_project_match) !== Boolean(right.entity_or_project_match)) {
      return left.entity_or_project_match ? -1 : 1;
    }
    const retrievalDelta = (right.retrieval_rank ?? 0) - (left.retrieval_rank ?? 0);
    if (retrievalDelta !== 0) return retrievalDelta;
    const lexicalDelta = (right.lexical_rank ?? 0) - (left.lexical_rank ?? 0);
    if (lexicalDelta !== 0) return lexicalDelta;
    return (right.importance ?? 5) - (left.importance ?? 5);
  });

  const localLexical = selectMemoriesForQuery(candidates, query, candidates.length) as HybridMemoryCandidate[];
  const merged: HybridMemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const memory of [...databaseRanked, ...localLexical]) {
    const key = memoryIdentity(memory);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(memory);
  }
  return merged;
}

function semanticOrder(
  results: readonly SemanticSearchResult[] | null | undefined,
): readonly HybridMemoryCandidate[] {
  if (!results) return [];
  return results.map((result) => ({
    ...result.memory,
    relevance: result.similarity,
  }));
}

/**
 * Reciprocal-rank fusion over exact lexical, broad lexical, semantic,
 * high-importance identity/project anchors, and active-chat memory lists.
 *
 * The function never chooses semantic *instead of* lexical results. Exact
 * lexical matches are protected during diversity selection, and superseded
 * candidates are excluded defensively even though the RPC already filters them.
 */
export function fuseMemoryRetrieval(args: {
  readonly candidates: readonly HybridMemoryCandidate[];
  readonly semanticResults?: readonly SemanticSearchResult[] | null;
  readonly query: string;
  readonly conversationId?: string;
  readonly limit?: number;
}): readonly FusedMemoryCandidate[] {
  const limit = Math.max(1, Math.min(args.limit ?? 6, 12));
  const activeCandidates = args.candidates.filter((memory) => memory.status !== "superseded");
  const lexical = lexicalOrder(activeCandidates, args.query);
  const exact = lexical.filter((memory) => memory.exact_phrase_match);
  const semantic = semanticOrder(args.semanticResults)
    .filter((memory) => memory.status !== "superseded");
  const anchors = activeCandidates
    .filter(isHighImportanceAnchor)
    .sort((left, right) => {
      const importanceDelta = (right.importance ?? 5) - (left.importance ?? 5);
      if (importanceDelta !== 0) return importanceDelta;
      return Date.parse(right.last_confirmed_at ?? right.created_at ?? "") -
        Date.parse(left.last_confirmed_at ?? left.created_at ?? "");
    });
  const activeChat = activeCandidates
    .filter((memory) => isActiveChatMemory(memory, args.conversationId))
    .sort((left, right) => {
      const importanceDelta = (right.importance ?? 5) - (left.importance ?? 5);
      if (importanceDelta !== 0) return importanceDelta;
      return Date.parse(right.last_confirmed_at ?? right.created_at ?? "") -
        Date.parse(left.last_confirmed_at ?? left.created_at ?? "");
    });

  type Accumulator = {
    memory: HybridMemoryCandidate;
    score: number;
    sources: Set<string>;
    exact: boolean;
  };
  const fused = new Map<string, Accumulator>();

  const addRanked = (
    memories: readonly HybridMemoryCandidate[],
    source: string,
    weight: number,
  ) => {
    memories.forEach((memory, index) => {
      const key = memoryIdentity(memory);
      const current = fused.get(key) ?? {
        memory,
        score: 0,
        sources: new Set<string>(),
        exact: Boolean(memory.exact_phrase_match),
      };
      current.score += rankContribution(index + 1, weight);
      current.sources.add(source);
      current.exact ||= Boolean(memory.exact_phrase_match);
      if ((memory.retrieval_rank ?? 0) > (current.memory.retrieval_rank ?? 0)) {
        current.memory = memory;
      }
      fused.set(key, current);
    });
  };

  addRanked(exact, "exact", EXACT_WEIGHT);
  addRanked(lexical, "lexical", LEXICAL_WEIGHT);
  addRanked(semantic, "semantic", SEMANTIC_WEIGHT);
  addRanked(anchors, "anchor", ANCHOR_WEIGHT);
  addRanked(activeChat, "active_chat", ACTIVE_CHAT_WEIGHT);

  const ordered = [...fused.values()].sort((left, right) => {
    if (left.exact !== right.exact) return left.exact ? -1 : 1;
    if (right.score !== left.score) return right.score - left.score;
    const importanceDelta = (right.memory.importance ?? 5) - (left.memory.importance ?? 5);
    if (importanceDelta !== 0) return importanceDelta;
    return (right.memory.retrieval_rank ?? 0) - (left.memory.retrieval_rank ?? 0);
  });

  const selected: FusedMemoryCandidate[] = [];
  const subjectCounts = new Map<string, number>();
  const factTypeCounts = new Map<string, number>();

  for (const item of ordered) {
    const subject = item.memory.subject_key || memoryIdentity(item.memory);
    const factType = item.memory.fact_type || item.memory.type;
    const subjectCount = subjectCounts.get(subject) ?? 0;
    const factTypeCount = factTypeCounts.get(factType) ?? 0;

    // Supersession should already leave one active item per subject. This
    // defensive quota also protects mixed local/cloud candidates.
    if (!item.exact && subjectCount >= 1) continue;
    if (!item.exact && factTypeCount >= 2 && ordered.length > limit) continue;

    selected.push({
      ...item.memory,
      relevance: item.score,
      retrieval_sources: [...item.sources].sort(),
    });
    subjectCounts.set(subject, subjectCount + 1);
    factTypeCounts.set(factType, factTypeCount + 1);
    if (selected.length >= limit) break;
  }

  return selected;
}
