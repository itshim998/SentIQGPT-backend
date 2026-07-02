import type { SupabaseClient } from "@supabase/supabase-js";
import { callLLMAdapterDetailed } from "../ai/PromptBuilders";
import { estimateTextTokens, trimTextToTokenBudget } from "../orchestrator/contextBudgetManager";
import {
  getConversationMessages,
  type ConversationMessageRow,
} from "./conversationService";

export type ContextCapsuleScope = "conversation" | "workspace";

export interface ContextCapsuleRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly scope: ContextCapsuleScope;
  readonly conversation_id: string | null;
  readonly content: string;
  readonly source_message_count: number;
  readonly source_cursor: string | null;
  readonly version: number;
  readonly updated_at: string;
  readonly created_at: string;
  readonly metadata: Record<string, unknown>;
}

export interface ContextCapsulePair {
  readonly conversation?: ContextCapsuleRow;
  readonly workspace?: ContextCapsuleRow;
}

export interface ContextCapsuleWriteInput {
  readonly userDb: SupabaseClient | any;
  readonly ownerUserId: string;
  readonly scope: ContextCapsuleScope;
  readonly conversationId?: string;
  readonly content: string;
  readonly sourceMessageCount: number;
  readonly sourceCursor?: string;
  readonly expectedVersion: number;
  readonly metadata?: Record<string, unknown>;
}

export type ContextCapsuleWriteResult =
  | { readonly status: "written"; readonly capsule: ContextCapsuleRow }
  | { readonly status: "conflict" };

interface DurableMemoryRow {
  readonly type: string;
  readonly summary: string;
  readonly importance?: number;
}

export interface ContextCapsuleServiceDependencies {
  readonly readCapsule?: (args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    scope: ContextCapsuleScope;
    conversationId?: string;
  }) => Promise<ContextCapsuleRow | undefined>;
  readonly writeCapsuleCas?: (input: ContextCapsuleWriteInput) => Promise<ContextCapsuleWriteResult>;
  readonly listMessages?: (
    userDb: SupabaseClient | any,
    conversationId: string,
  ) => Promise<readonly ConversationMessageRow[]>;
  readonly listConversationCapsules?: (
    userDb: SupabaseClient | any,
    ownerUserId: string,
  ) => Promise<readonly ContextCapsuleRow[]>;
  readonly listDurableMemories?: (
    userDb: SupabaseClient | any,
    ownerUserId: string,
  ) => Promise<readonly DurableMemoryRow[]>;
  readonly generateSummary?: (prompt: string) => Promise<string>;
}

const CAPSULE_COLUMNS =
  "id,owner_user_id,scope,conversation_id,content,source_message_count,source_cursor,version,updated_at,created_at,metadata";
const CONVERSATION_MESSAGE_THRESHOLD = 8;
const CONVERSATION_TOKEN_THRESHOLD = 6_000;
const WORKSPACE_UPDATE_THRESHOLD = 4;
const MAX_CONVERSATION_TRANSCRIPT_TOKENS = 6_000;
const MAX_CAPSULE_OUTPUT_TOKENS = 400;
const MAX_WORKSPACE_SOURCE_TOKENS = 6_000;

function isGuestIdentity(userId: string | undefined): boolean {
  const normalized = userId?.trim().toLowerCase() ?? "";
  return !normalized || normalized === "guest" || normalized.startsWith("guest-");
}

function logCapsule(event: string, details: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({
    scope: "context_capsule",
    event,
    ...details,
  }));
}

function normalizeCapsuleRow(value: unknown): ContextCapsuleRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const scope = row.scope === "workspace" ? "workspace" : row.scope === "conversation" ? "conversation" : undefined;
  const version = Number(row.version);
  const sourceMessageCount = Number(row.source_message_count);
  if (
    !scope ||
    typeof row.id !== "string" ||
    typeof row.owner_user_id !== "string" ||
    typeof row.content !== "string" ||
    !Number.isFinite(version) ||
    version < 1
  ) {
    return undefined;
  }
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    scope,
    conversation_id: typeof row.conversation_id === "string" ? row.conversation_id : null,
    content: row.content,
    source_message_count: Number.isFinite(sourceMessageCount) ? Math.max(0, Math.floor(sourceMessageCount)) : 0,
    source_cursor: typeof row.source_cursor === "string" ? row.source_cursor : null,
    version: Math.floor(version),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {},
  };
}

async function defaultReadCapsule(args: {
  userDb: SupabaseClient | any;
  ownerUserId: string;
  scope: ContextCapsuleScope;
  conversationId?: string;
}): Promise<ContextCapsuleRow | undefined> {
  let query = args.userDb
    .from("context_capsules")
    .select(CAPSULE_COLUMNS)
    .eq("owner_user_id", args.ownerUserId)
    .eq("scope", args.scope);
  query = args.scope === "conversation"
    ? query.eq("conversation_id", args.conversationId)
    : query.is("conversation_id", null);
  const result = await query.maybeSingle();
  if (result.error && result.error.code !== "PGRST116") throw result.error;
  return normalizeCapsuleRow(result.data);
}

async function defaultWriteCapsuleCas(input: ContextCapsuleWriteInput): Promise<ContextCapsuleWriteResult> {
  if (input.expectedVersion === 0) {
    const result = await input.userDb
      .from("context_capsules")
      .insert({
        owner_user_id: input.ownerUserId,
        scope: input.scope,
        conversation_id: input.scope === "conversation" ? input.conversationId : null,
        content: input.content,
        source_message_count: input.sourceMessageCount,
        source_cursor: input.sourceCursor ?? null,
        version: 1,
        metadata: input.metadata ?? {},
      })
      .select(CAPSULE_COLUMNS)
      .single();
    if (result.error?.code === "23505") return { status: "conflict" };
    if (result.error) throw result.error;
    const capsule = normalizeCapsuleRow(result.data);
    if (!capsule) throw new Error("Invalid context capsule insert result");
    return { status: "written", capsule };
  }

  let query = input.userDb
    .from("context_capsules")
    .update({
      content: input.content,
      source_message_count: input.sourceMessageCount,
      source_cursor: input.sourceCursor ?? null,
      version: input.expectedVersion + 1,
      metadata: input.metadata ?? {},
    })
    .eq("owner_user_id", input.ownerUserId)
    .eq("scope", input.scope)
    .eq("version", input.expectedVersion);
  query = input.scope === "conversation"
    ? query.eq("conversation_id", input.conversationId)
    : query.is("conversation_id", null);
  const result = await query.select(CAPSULE_COLUMNS).maybeSingle();
  if (result.error && result.error.code !== "PGRST116") throw result.error;
  const capsule = normalizeCapsuleRow(result.data);
  return capsule ? { status: "written", capsule } : { status: "conflict" };
}

async function defaultListMessages(
  userDb: SupabaseClient | any,
  conversationId: string,
): Promise<readonly ConversationMessageRow[]> {
  const result = await getConversationMessages(userDb, conversationId);
  if (result.error) throw result.error;
  return result.data;
}

async function defaultListConversationCapsules(
  userDb: SupabaseClient | any,
  ownerUserId: string,
): Promise<readonly ContextCapsuleRow[]> {
  const result = await userDb
    .from("context_capsules")
    .select(CAPSULE_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .eq("scope", "conversation")
    .order("updated_at", { ascending: false })
    .limit(8);
  if (result.error) throw result.error;
  return (result.data ?? []).map(normalizeCapsuleRow).filter((row: ContextCapsuleRow | undefined): row is ContextCapsuleRow => Boolean(row));
}

async function defaultListDurableMemories(
  userDb: SupabaseClient | any,
  ownerUserId: string,
): Promise<readonly DurableMemoryRow[]> {
  const result = await userDb
    .from("memories")
    .select("type,summary,importance")
    .eq("user_id", ownerUserId)
    .eq("scope", "global")
    .order("importance", { ascending: false })
    .limit(12);
  if (result.error) throw result.error;
  return (result.data ?? []) as DurableMemoryRow[];
}

async function defaultGenerateSummary(prompt: string): Promise<string> {
  const result = await callLLMAdapterDetailed({
    task: "memory_compress",
    prompt,
    prefer: "groq",
    max_output_tokens: MAX_CAPSULE_OUTPUT_TOKENS,
    budget_class: "auxiliary",
    auxiliary_budget: "memory",
    request_complexity: "normal",
    skip_wrappers: true,
  });
  if (result.error || !result.text.trim()) {
    throw new Error(result.error || "Capsule summary was empty");
  }
  return trimTextToTokenBudget(result.text.trim(), MAX_CAPSULE_OUTPUT_TOKENS, "head_tail");
}

export class ContextCapsuleService {
  private readonly dependencies: Required<ContextCapsuleServiceDependencies>;
  private readonly cache = new Map<string, ContextCapsuleRow>();
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly rerunRequested = new Set<string>();

  constructor(dependencies: ContextCapsuleServiceDependencies = {}) {
    this.dependencies = {
      readCapsule: dependencies.readCapsule ?? defaultReadCapsule,
      writeCapsuleCas: dependencies.writeCapsuleCas ?? defaultWriteCapsuleCas,
      listMessages: dependencies.listMessages ?? defaultListMessages,
      listConversationCapsules: dependencies.listConversationCapsules ?? defaultListConversationCapsules,
      listDurableMemories: dependencies.listDurableMemories ?? defaultListDurableMemories,
      generateSummary: dependencies.generateSummary ?? defaultGenerateSummary,
    };
  }

  private cacheKey(ownerUserId: string, scope: ContextCapsuleScope, conversationId?: string): string {
    return scope === "workspace"
      ? `${ownerUserId}:workspace`
      : `${ownerUserId}:conversation:${conversationId ?? ""}`;
  }

  private remember(capsule: ContextCapsuleRow): void {
    this.cache.set(this.cacheKey(capsule.owner_user_id, capsule.scope, capsule.conversation_id ?? undefined), capsule);
  }

  peekCachedCapsules(ownerUserId: string, conversationId?: string): ContextCapsulePair {
    if (isGuestIdentity(ownerUserId)) return {};
    return {
      conversation: conversationId
        ? this.cache.get(this.cacheKey(ownerUserId, "conversation", conversationId))
        : undefined,
      workspace: this.cache.get(this.cacheKey(ownerUserId, "workspace")),
    };
  }

  async readConversationCapsule(args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    conversationId: string;
  }): Promise<ContextCapsuleRow | undefined> {
    if (isGuestIdentity(args.ownerUserId) || !args.userDb || !args.conversationId) {
      logCapsule("read_skipped", { capsule_scope: "conversation", reason: "guest_or_missing_context" });
      return undefined;
    }
    try {
      const capsule = await this.dependencies.readCapsule({ ...args, scope: "conversation" });
      if (capsule) this.remember(capsule);
      logCapsule("read", { capsule_scope: "conversation", found: Boolean(capsule) });
      return capsule;
    } catch (error) {
      logCapsule("read_skipped", {
        capsule_scope: "conversation",
        reason: "read_failed",
        error_type: error instanceof Error ? error.name : "unknown",
      });
      return this.peekCachedCapsules(args.ownerUserId, args.conversationId).conversation;
    }
  }

  async readWorkspaceCapsule(args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
  }): Promise<ContextCapsuleRow | undefined> {
    if (isGuestIdentity(args.ownerUserId) || !args.userDb) {
      logCapsule("read_skipped", { capsule_scope: "workspace", reason: "guest_or_missing_context" });
      return undefined;
    }
    try {
      const capsule = await this.dependencies.readCapsule({ ...args, scope: "workspace" });
      if (capsule) this.remember(capsule);
      logCapsule("read", { capsule_scope: "workspace", found: Boolean(capsule) });
      return capsule;
    } catch (error) {
      logCapsule("read_skipped", {
        capsule_scope: "workspace",
        reason: "read_failed",
        error_type: error instanceof Error ? error.name : "unknown",
      });
      return this.peekCachedCapsules(args.ownerUserId).workspace;
    }
  }

  async readCapsules(args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    conversationId?: string;
  }): Promise<ContextCapsulePair> {
    const [conversation, workspace] = await Promise.all([
      args.conversationId
        ? this.readConversationCapsule({ ...args, conversationId: args.conversationId })
        : Promise.resolve(undefined),
      this.readWorkspaceCapsule(args),
    ]);
    return { conversation, workspace };
  }

  async updateWithVersion(input: ContextCapsuleWriteInput): Promise<ContextCapsuleWriteResult> {
    if (isGuestIdentity(input.ownerUserId) || !input.userDb) {
      logCapsule("write_skipped", { capsule_scope: input.scope, reason: "guest_or_missing_context" });
      return { status: "conflict" };
    }
    const result = await this.dependencies.writeCapsuleCas(input);
    if (result.status === "written") {
      this.remember(result.capsule);
      logCapsule("write", {
        capsule_scope: input.scope,
        version: result.capsule.version,
        estimated_summary_tokens: estimateTextTokens(result.capsule.content),
      });
    } else {
      logCapsule("write_skipped", { capsule_scope: input.scope, reason: "version_conflict" });
    }
    return result;
  }

  scheduleRefresh(args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    conversationId: string;
  }): boolean {
    if (isGuestIdentity(args.ownerUserId) || !args.userDb || !args.conversationId) {
      logCapsule("refresh_skipped", { capsule_scope: "conversation", reason: "guest_or_missing_context" });
      return false;
    }
    const key = this.cacheKey(args.ownerUserId, "conversation", args.conversationId);
    if (this.scheduled.has(key)) {
      this.rerunRequested.add(key);
      logCapsule("refresh_skipped", { capsule_scope: "conversation", reason: "already_scheduled_coalesced" });
      return false;
    }
    logCapsule("refresh_scheduled", { capsule_scope: "conversation" });
    const task = Promise.resolve()
      .then(() => this.refreshConversationCapsule(args))
      .catch((error) => {
        logCapsule("refresh_skipped", {
          capsule_scope: "conversation",
          reason: "refresh_failed",
          error_type: error instanceof Error ? error.name : "unknown",
        });
      });
    this.scheduled.set(key, task);
    void task.finally(() => {
      this.scheduled.delete(key);
      if (this.rerunRequested.delete(key)) {
        this.scheduleRefresh(args);
      }
    });
    return true;
  }

  async waitForScheduledRefreshesForTests(): Promise<void> {
    while (this.scheduled.size > 0) {
      await Promise.all([...this.scheduled.values()]);
    }
  }

  private async refreshConversationCapsule(args: {
    userDb: SupabaseClient | any;
    ownerUserId: string;
    conversationId: string;
  }): Promise<void> {
    const [capsule, messages] = await Promise.all([
      this.readConversationCapsule(args),
      this.dependencies.listMessages(args.userDb, args.conversationId),
    ]);
    const cursorIndex = capsule?.source_cursor
      ? messages.findIndex((message) => message.id === capsule.source_cursor)
      : -1;
    const startIndex = cursorIndex >= 0
      ? cursorIndex + 1
      : Math.min(capsule?.source_message_count ?? 0, messages.length);
    const unsummarized = messages
      .slice(startIndex)
      .filter((message) => message.content.trim().length > 0);
    const unsummarizedText = unsummarized
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");
    const estimatedNewTokens = estimateTextTokens(unsummarizedText);
    if (
      unsummarized.length < CONVERSATION_MESSAGE_THRESHOLD &&
      estimatedNewTokens < CONVERSATION_TOKEN_THRESHOLD
    ) {
      logCapsule("refresh_skipped", {
        capsule_scope: "conversation",
        reason: "threshold_not_met",
        unsummarized_messages: unsummarized.length,
        estimated_new_tokens: estimatedNewTokens,
      });
      return;
    }

    const previous = capsule
      ? trimTextToTokenBudget(capsule.content, MAX_CAPSULE_OUTPUT_TOKENS, "head_tail")
      : "No previous capsule exists.";
    const transcript = trimTextToTokenBudget(
      unsummarizedText,
      MAX_CONVERSATION_TRANSCRIPT_TOKENS,
      "head_tail",
    );
    const prompt = [
      "Update a compact conversation capsule from the previous capsule and only the new messages.",
      "Capture durable goals, decisions, constraints, named project facts, and unresolved work.",
      "Prefer current information when new messages supersede older details.",
      "Do not quote the transcript or invent facts. Return only the updated capsule text.",
      "",
      "PREVIOUS CAPSULE:",
      previous,
      "",
      "NEW MESSAGES:",
      transcript,
    ].join("\n");
    const content = await this.dependencies.generateSummary(prompt);
    const lastMessage = messages[messages.length - 1];
    const write = await this.updateWithVersion({
      userDb: args.userDb,
      ownerUserId: args.ownerUserId,
      scope: "conversation",
      conversationId: args.conversationId,
      content,
      sourceMessageCount: messages.length,
      sourceCursor: lastMessage?.id,
      expectedVersion: capsule?.version ?? 0,
      metadata: {
        ...(capsule?.metadata ?? {}),
        refresh_count: Number(capsule?.metadata.refresh_count ?? 0) + 1,
        last_unsummarized_message_count: unsummarized.length,
      },
    });
    if (write.status === "written") {
      try {
        await this.refreshWorkspaceCapsuleIfNeeded(args.userDb, args.ownerUserId);
      } catch (error) {
        logCapsule("refresh_skipped", {
          capsule_scope: "workspace",
          reason: "refresh_failed",
          error_type: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  private async refreshWorkspaceCapsuleIfNeeded(
    userDb: SupabaseClient | any,
    ownerUserId: string,
  ): Promise<void> {
    const [workspace, conversationCapsules] = await Promise.all([
      this.readWorkspaceCapsule({ userDb, ownerUserId }),
      this.dependencies.listConversationCapsules(userDb, ownerUserId),
    ]);
    const sourceVersionTotal = conversationCapsules.reduce((sum, capsule) => sum + capsule.version, 0);
    const previousSourceVersionTotal = Number(workspace?.metadata.source_conversation_version_total ?? 0);
    if (sourceVersionTotal - previousSourceVersionTotal < WORKSPACE_UPDATE_THRESHOLD) {
      logCapsule("refresh_skipped", { capsule_scope: "workspace", reason: "threshold_not_met" });
      return;
    }
    logCapsule("refresh_scheduled", { capsule_scope: "workspace" });
    const memories = await this.dependencies.listDurableMemories(userDb, ownerUserId);
    const source = trimTextToTokenBudget([
      "RECENT CONVERSATION CAPSULES:",
      ...conversationCapsules.map((capsule, index) => `${index + 1}. ${capsule.content}`),
      "",
      "DURABLE MEMORIES:",
      ...memories.map((memory) => `[${memory.type}] ${memory.summary}`),
    ].join("\n"), MAX_WORKSPACE_SOURCE_TOKENS, "head_tail");
    const previous = workspace
      ? trimTextToTokenBudget(workspace.content, MAX_CAPSULE_OUTPUT_TOKENS, "head_tail")
      : "No previous workspace capsule exists.";
    const prompt = [
      "Update a compact workspace capsule using conversation capsules and durable memories only.",
      "Capture recurring projects, stable goals, working preferences, constraints, and unresolved cross-conversation work.",
      "Do not include unrelated chat details, raw transcripts, or invented facts. Return only the capsule text.",
      "",
      "PREVIOUS WORKSPACE CAPSULE:",
      previous,
      "",
      source,
    ].join("\n");
    const content = await this.dependencies.generateSummary(prompt);
    await this.updateWithVersion({
      userDb,
      ownerUserId,
      scope: "workspace",
      content,
      sourceMessageCount: conversationCapsules.reduce((sum, capsule) => sum + capsule.source_message_count, 0),
      expectedVersion: workspace?.version ?? 0,
      metadata: {
        ...(workspace?.metadata ?? {}),
        source_conversation_version_total: sourceVersionTotal,
        source_conversation_capsule_count: conversationCapsules.length,
        durable_memory_count: memories.length,
      },
    });
  }
}

export const contextCapsuleService = new ContextCapsuleService();
