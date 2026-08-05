import type { SupabaseClient } from "@supabase/supabase-js";

export const CROSS_CONVERSATION_CONTINUITY_SCHEMA_VERSION = 1;
export const CROSS_CONVERSATION_PROJECT_LIMIT = 3;
export const CROSS_CONVERSATION_SOURCE_LIMIT = 6;

const CONTINUITY_CUE_PATTERN = /\b(?:continue|resume|pick\s+up|where\s+were\s+we|what\s+next|next\s+step|status|progress|go\s+back|return\s+to|as\s+discussed|we\s+decided|our\s+plan|our\s+project|previous|earlier|remember|recall)\b/i;
const PROJECT_REFERENCE_PATTERN = /\b(?:project|system|repo|repository|backend|frontend|migration|rollout|latency|pipeline|pdf|document|memory|retrieval|deployment|azure|supabase|github|studentos|sentiq)\b/i;
const CAPITALIZED_ENTITY_PATTERN = /\b[A-Z][A-Za-z0-9_-]{2,}(?:\s+[A-Z][A-Za-z0-9_-]{2,}){0,2}\b/;

export interface ContinuityStableFact {
  readonly memoryId: string;
  readonly summary: string;
  readonly factType?: string;
  readonly subjectKey?: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly lastConfirmedAt?: string;
}

export interface ContinuityProjectCapsule {
  readonly capsuleId: string;
  readonly conversationId: string;
  readonly conversationTitle?: string;
  readonly content: string;
  readonly projectKey?: string;
  readonly entityKeys: readonly string[];
  readonly version?: number;
  readonly updatedAt?: string;
  readonly retrievalRank: number;
  readonly provenanceKind: "capsule";
  readonly supportsExactClaim: false;
}

export interface ContinuityUnresolvedWork {
  readonly memoryId: string;
  readonly summary: string;
  readonly subjectKey?: string;
  readonly projectScope?: string;
  readonly temporalScope?: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly lastConfirmedAt?: string;
  readonly provenanceKind: "memory";
  readonly supportsSavedFact: true;
  readonly supportsExactClaim: false;
}

export interface ContinuitySourceEvidence {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationTitle?: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly createdAt: string;
  readonly lexicalRank: number;
  readonly provenanceKind: "source_message";
  readonly supportsExactClaim: true;
}

export interface CrossConversationContinuity {
  readonly schemaVersion: number;
  readonly stableFacts: readonly ContinuityStableFact[];
  readonly projectCapsules: readonly ContinuityProjectCapsule[];
  readonly unresolvedWork: readonly ContinuityUnresolvedWork[];
  readonly sourceEvidence: readonly ContinuitySourceEvidence[];
}

export interface ContinuityFetchResult {
  readonly status: "available" | "degraded" | "skipped";
  readonly continuity: CrossConversationContinuity;
  readonly errorCode?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && value.toLowerCase() === "true");
}

function emptyContinuity(): CrossConversationContinuity {
  return {
    schemaVersion: CROSS_CONVERSATION_CONTINUITY_SCHEMA_VERSION,
    stableFacts: [],
    projectCapsules: [],
    unresolvedWork: [],
    sourceEvidence: [],
  };
}

export function shouldSearchCrossConversationContinuity(query: string): boolean {
  const trimmed = query.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length < 4) return false;
  if (CONTINUITY_CUE_PATTERN.test(trimmed)) return true;
  if (PROJECT_REFERENCE_PATTERN.test(trimmed)) return true;
  return trimmed.split(" ").length >= 3 && CAPITALIZED_ENTITY_PATTERN.test(trimmed);
}

export function normalizeCrossConversationContinuity(value: unknown): CrossConversationContinuity {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return emptyContinuity();
    }
  }
  if (Array.isArray(candidate) && candidate.length === 1) candidate = candidate[0];
  const row = asObject(candidate);
  if (!row) return emptyContinuity();

  const stableUser = asObject(row.stable_user_capsule ?? row.stableUserCapsule);
  const stableFacts = asArray(stableUser?.facts)
    .map((item): ContinuityStableFact | undefined => {
      const fact = asObject(item);
      const memoryId = asString(fact?.memory_id ?? fact?.memoryId);
      const summary = asString(fact?.summary);
      if (!memoryId || !summary) return undefined;
      const importance = asNumber(fact?.importance, Number.NaN);
      const confidence = asNumber(fact?.confidence, Number.NaN);
      return {
        memoryId,
        summary,
        factType: asString(fact?.fact_type ?? fact?.factType),
        subjectKey: asString(fact?.subject_key ?? fact?.subjectKey),
        importance: Number.isFinite(importance) ? importance : undefined,
        confidence: Number.isFinite(confidence) ? confidence : undefined,
        lastConfirmedAt: asString(fact?.last_confirmed_at ?? fact?.lastConfirmedAt),
      };
    })
    .filter((item): item is ContinuityStableFact => Boolean(item));

  const projectCapsules = asArray(row.project_capsules ?? row.projectCapsules)
    .map((item): ContinuityProjectCapsule | undefined => {
      const capsule = asObject(item);
      const capsuleId = asString(capsule?.capsule_id ?? capsule?.capsuleId);
      const conversationId = asString(capsule?.conversation_id ?? capsule?.conversationId);
      const content = asString(capsule?.content);
      if (!capsuleId || !conversationId || !content) return undefined;
      return {
        capsuleId,
        conversationId,
        conversationTitle: asString(capsule?.conversation_title ?? capsule?.conversationTitle),
        content,
        projectKey: asString(capsule?.project_key ?? capsule?.projectKey),
        entityKeys: asArray(capsule?.entity_keys ?? capsule?.entityKeys)
          .map(asString)
          .filter((key): key is string => Boolean(key)),
        version: Number.isFinite(asNumber(capsule?.version, Number.NaN))
          ? asNumber(capsule?.version)
          : undefined,
        updatedAt: asString(capsule?.updated_at ?? capsule?.updatedAt),
        retrievalRank: Math.max(0, asNumber(capsule?.retrieval_rank ?? capsule?.retrievalRank)),
        provenanceKind: "capsule",
        supportsExactClaim: false,
      };
    })
    .filter((item): item is ContinuityProjectCapsule => Boolean(item))
    .slice(0, CROSS_CONVERSATION_PROJECT_LIMIT);

  const unresolvedWork = asArray(row.unresolved_work ?? row.unresolvedWork)
    .map((item): ContinuityUnresolvedWork | undefined => {
      const work = asObject(item);
      const memoryId = asString(work?.memory_id ?? work?.memoryId);
      const summary = asString(work?.summary);
      if (!memoryId || !summary) return undefined;
      const importance = asNumber(work?.importance, Number.NaN);
      const confidence = asNumber(work?.confidence, Number.NaN);
      return {
        memoryId,
        summary,
        subjectKey: asString(work?.subject_key ?? work?.subjectKey),
        projectScope: asString(work?.project_scope ?? work?.projectScope),
        temporalScope: asString(work?.temporal_scope ?? work?.temporalScope),
        importance: Number.isFinite(importance) ? importance : undefined,
        confidence: Number.isFinite(confidence) ? confidence : undefined,
        lastConfirmedAt: asString(work?.last_confirmed_at ?? work?.lastConfirmedAt),
        provenanceKind: "memory",
        supportsSavedFact: true,
        supportsExactClaim: false,
      };
    })
    .filter((item): item is ContinuityUnresolvedWork => Boolean(item));

  const sourceEvidence = asArray(row.source_evidence ?? row.sourceEvidence)
    .map((item): ContinuitySourceEvidence | undefined => {
      const evidence = asObject(item);
      const messageId = asString(evidence?.message_id ?? evidence?.messageId);
      const conversationId = asString(evidence?.conversation_id ?? evidence?.conversationId);
      const role = evidence?.role === "user" || evidence?.role === "assistant" ? evidence.role : undefined;
      const content = asString(evidence?.content);
      const createdAt = asString(evidence?.created_at ?? evidence?.createdAt);
      if (!messageId || !conversationId || !role || !content || !createdAt) return undefined;
      return {
        messageId,
        conversationId,
        conversationTitle: asString(evidence?.conversation_title ?? evidence?.conversationTitle),
        role,
        content,
        contentTruncated: asBoolean(evidence?.content_truncated ?? evidence?.contentTruncated),
        createdAt,
        lexicalRank: Math.max(0, asNumber(evidence?.lexical_rank ?? evidence?.lexicalRank)),
        provenanceKind: "source_message",
        supportsExactClaim: true,
      };
    })
    .filter((item): item is ContinuitySourceEvidence => Boolean(item))
    .slice(0, CROSS_CONVERSATION_SOURCE_LIMIT);

  return {
    schemaVersion: Math.max(1, Math.floor(asNumber(row.schema_version ?? row.schemaVersion, 1))),
    stableFacts,
    projectCapsules,
    unresolvedWork,
    sourceEvidence,
  };
}

export function formatCrossConversationContinuityForPrompt(
  continuity: CrossConversationContinuity,
): string | undefined {
  const sections: string[] = [];

  if (continuity.stableFacts.length > 0) {
    sections.push([
      "STABLE USER CAPSULE — provenance: saved memory; supports saved facts, not exact past wording:",
      ...continuity.stableFacts.map((fact) => `- ${fact.summary}`),
    ].join("\n"));
  }

  continuity.projectCapsules.forEach((capsule, index) => {
    const title = capsule.conversationTitle || capsule.projectKey || `Project ${index + 1}`;
    sections.push([
      `PROJECT CAPSULE ${index + 1}: ${title}`,
      "Provenance: capsule; broad continuity only; not evidence of exact prior wording or a precise past claim.",
      capsule.content,
    ].join("\n"));
  });

  if (continuity.unresolvedWork.length > 0) {
    sections.push([
      "UNRESOLVED WORK RECORDS — provenance: saved memory; pending state only, not transcript evidence:",
      ...continuity.unresolvedWork.map((work) => `- ${work.summary}`),
    ].join("\n"));
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export async function fetchCrossConversationContinuity(args: {
  readonly userDb?: SupabaseClient | any;
  readonly ownerUserId?: string;
  readonly query: string;
  readonly currentConversationId?: string;
}): Promise<ContinuityFetchResult> {
  if (
    !args.userDb
    || typeof args.userDb.rpc !== "function"
    || !args.ownerUserId?.trim()
    || !shouldSearchCrossConversationContinuity(args.query)
  ) {
    return { status: "skipped", continuity: emptyContinuity() };
  }

  try {
    const { data, error } = await args.userDb.rpc("search_cross_conversation_context", {
      p_owner_user_id: args.ownerUserId,
      p_query: args.query,
      p_current_conversation_id: args.currentConversationId ?? null,
      p_project_limit: CROSS_CONVERSATION_PROJECT_LIMIT,
      p_source_limit: CROSS_CONVERSATION_SOURCE_LIMIT,
      p_assistant_excerpt_chars: 700,
    });
    if (error) {
      return {
        status: "degraded",
        continuity: emptyContinuity(),
        errorCode: error.code || "continuity_rpc_error",
      };
    }
    const continuity = normalizeCrossConversationContinuity(data);
    if (continuity.schemaVersion !== CROSS_CONVERSATION_CONTINUITY_SCHEMA_VERSION) {
      return { status: "degraded", continuity: emptyContinuity(), errorCode: "continuity_schema_mismatch" };
    }
    return { status: "available", continuity };
  } catch (error) {
    return {
      status: "degraded",
      continuity: emptyContinuity(),
      errorCode: error instanceof Error ? error.name : "continuity_exception",
    };
  }
}
