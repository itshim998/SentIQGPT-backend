import type { SupabaseClient } from "@supabase/supabase-js";
import { collapseAdjacentDuplicateMessages } from "../context/messageDeduper";

export const FAST_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1;
export const FAST_CONTEXT_SNAPSHOT_MESSAGE_LIMIT = 20;
export const FAST_CONTEXT_SNAPSHOT_MEMORY_LIMIT = 8;
export const FAST_CONTEXT_SNAPSHOT_SOURCE_LIMIT = 12;
export const DEFAULT_FAST_CONTEXT_SNAPSHOT_TIMEOUT_MS = 225;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FastContextSnapshotStatus = "available" | "timeout" | "degraded" | "skipped";

export interface FastSnapshotMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly clientRequestId?: string;
  readonly messageType?: string;
}

export interface FastSnapshotCapsule {
  readonly id: string;
  readonly scope: "conversation" | "workspace";
  readonly conversationId?: string;
  readonly content: string;
  readonly sourceMessageCount: number;
  readonly sourceCursor?: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface FastSnapshotMemory {
  readonly id: string;
  readonly type: string;
  readonly summary: string;
  readonly importance?: number;
  readonly scope: "global" | "chat";
  readonly chatId?: string;
  readonly createdAt?: string;
  readonly lexicalRank: number;
}

export interface FastSnapshotSourceDocument {
  readonly id: string;
  readonly conversationId?: string;
  readonly title: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sourceType: "pdf" | "text" | "code";
  readonly status: "processing" | "ready" | "failed";
  readonly createdAt?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface FastContextSnapshot {
  readonly schemaVersion: number;
  readonly conversationId: string;
  readonly messages: readonly FastSnapshotMessage[];
  readonly messageCursor?: { readonly id: string; readonly createdAt: string };
  readonly conversationCapsule?: FastSnapshotCapsule;
  readonly workspaceCapsule?: FastSnapshotCapsule;
  readonly memories: readonly FastSnapshotMemory[];
  readonly sourceDocuments: readonly FastSnapshotSourceDocument[];
  readonly cursors: {
    readonly messageId?: string;
    readonly messageCreatedAt?: string;
    readonly conversationCapsuleSourceCursor?: string;
    readonly conversationCapsuleVersion?: number;
    readonly workspaceCapsuleSourceCursor?: string;
    readonly workspaceCapsuleVersion?: number;
  };
}

export interface FastContextSnapshotFetchResult {
  readonly status: FastContextSnapshotStatus;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly snapshot?: FastContextSnapshot;
  readonly errorCode?: string;
}

export interface FastContextMessageHint {
  readonly role: string;
  readonly content: string;
}

function isGuestIdentity(userId: string | undefined): boolean {
  const normalized = userId?.trim().toLowerCase() ?? "";
  return !normalized || normalized === "guest" || normalized.startsWith("guest-");
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

export function resolveFastContextSnapshotTimeoutMs(explicit?: number): number {
  if (Number.isFinite(explicit)) {
    return positiveInteger(explicit, DEFAULT_FAST_CONTEXT_SNAPSHOT_TIMEOUT_MS, 25, 2_000);
  }
  return positiveInteger(
    process.env.SENTIQ_FAST_CONTEXT_SNAPSHOT_TIMEOUT_MS,
    DEFAULT_FAST_CONTEXT_SNAPSHOT_TIMEOUT_MS,
    25,
    2_000,
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return asObject(value) ?? {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeMessage(value: unknown): FastSnapshotMessage | undefined {
  const row = asObject(value);
  const role = row?.role === "user" || row?.role === "assistant" ? row.role : undefined;
  const id = asString(row?.id);
  const content = asString(row?.content);
  const createdAt = asString(row?.created_at ?? row?.createdAt);
  if (!role || !id || !content || !createdAt) return undefined;
  return {
    id,
    role,
    content,
    createdAt,
    clientRequestId: asString(row?.client_request_id ?? row?.clientRequestId),
    messageType: asString(row?.message_type ?? row?.messageType),
  };
}

function normalizeCapsule(value: unknown): FastSnapshotCapsule | undefined {
  const row = asObject(value);
  const scope = row?.scope === "conversation" || row?.scope === "workspace" ? row.scope : undefined;
  const id = asString(row?.id);
  const content = asString(row?.content);
  const updatedAt = asString(row?.updated_at ?? row?.updatedAt);
  const version = Number(row?.version);
  const sourceMessageCount = Number(row?.source_message_count ?? row?.sourceMessageCount);
  if (!scope || !id || !content || !updatedAt || !Number.isFinite(version) || version < 1) return undefined;
  return {
    id,
    scope,
    conversationId: asString(row?.conversation_id ?? row?.conversationId),
    content,
    sourceMessageCount: Number.isFinite(sourceMessageCount) ? Math.max(0, Math.floor(sourceMessageCount)) : 0,
    sourceCursor: asString(row?.source_cursor ?? row?.sourceCursor),
    version: Math.floor(version),
    updatedAt,
  };
}

function normalizeMemory(value: unknown): FastSnapshotMemory | undefined {
  const row = asObject(value);
  const id = asString(row?.id);
  const type = asString(row?.type);
  const summary = asString(row?.summary);
  if (!id || !type || !summary) return undefined;
  const importance = Number(row?.importance);
  const lexicalRank = Number(row?.lexical_rank ?? row?.lexicalRank);
  return {
    id,
    type,
    summary,
    importance: Number.isFinite(importance) ? Math.max(1, Math.min(10, Math.floor(importance))) : undefined,
    scope: row?.scope === "chat" ? "chat" : "global",
    chatId: asString(row?.chat_id ?? row?.chatId),
    createdAt: asString(row?.created_at ?? row?.createdAt),
    lexicalRank: Number.isFinite(lexicalRank) ? Math.max(0, lexicalRank) : 0,
  };
}

function normalizeSourceDocument(value: unknown): FastSnapshotSourceDocument | undefined {
  const row = asObject(value);
  const id = asString(row?.id);
  const title = asString(row?.title);
  const originalFilename = asString(row?.original_filename ?? row?.originalFilename);
  const mimeType = asString(row?.mime_type ?? row?.mimeType);
  const sourceTypeValue = row?.source_type ?? row?.sourceType;
  const sourceType = sourceTypeValue === "pdf" || sourceTypeValue === "text" || sourceTypeValue === "code"
    ? sourceTypeValue
    : undefined;
  const status = row?.status === "processing" || row?.status === "ready" || row?.status === "failed"
    ? row.status
    : undefined;
  if (!id || !title || !originalFilename || !mimeType || !sourceType || !status) return undefined;
  return {
    id,
    conversationId: asString(row?.conversation_id ?? row?.conversationId),
    title,
    originalFilename,
    mimeType,
    sourceType,
    status,
    createdAt: asString(row?.created_at ?? row?.createdAt),
    metadata: asRecord(row?.metadata),
  };
}

function normalizeCursor(value: unknown): FastContextSnapshot["messageCursor"] {
  const row = asObject(value);
  const id = asString(row?.id);
  const createdAt = asString(row?.created_at ?? row?.createdAt);
  return id && createdAt ? { id, createdAt } : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function normalizeFastContextSnapshot(value: unknown): FastContextSnapshot | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(candidate) && candidate.length === 1) candidate = candidate[0];
  const row = asObject(candidate);
  const conversationId = asString(row?.conversation_id ?? row?.conversationId);
  if (!row || !conversationId) return undefined;

  const messages = asArray(row.messages)
    .map(normalizeMessage)
    .filter((message): message is FastSnapshotMessage => Boolean(message));
  const memories = asArray(row.memories)
    .map(normalizeMemory)
    .filter((memory): memory is FastSnapshotMemory => Boolean(memory));
  const sourceDocuments = asArray(row.source_documents ?? row.sourceDocuments)
    .map(normalizeSourceDocument)
    .filter((document): document is FastSnapshotSourceDocument => Boolean(document));
  const conversationCapsule = normalizeCapsule(row.conversation_capsule ?? row.conversationCapsule);
  const workspaceCapsule = normalizeCapsule(row.workspace_capsule ?? row.workspaceCapsule);
  const messageCursor = normalizeCursor(row.message_cursor ?? row.messageCursor);
  const cursors = asObject(row.cursors);

  return {
    schemaVersion: positiveInteger(
      row.schema_version ?? row.schemaVersion,
      FAST_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    conversationId,
    messages,
    messageCursor,
    conversationCapsule,
    workspaceCapsule,
    memories,
    sourceDocuments,
    cursors: {
      messageId: asString(cursors?.message_id ?? cursors?.messageId) ?? messageCursor?.id,
      messageCreatedAt: asString(cursors?.message_created_at ?? cursors?.messageCreatedAt) ?? messageCursor?.createdAt,
      conversationCapsuleSourceCursor: asString(
        cursors?.conversation_capsule_source_cursor ?? cursors?.conversationCapsuleSourceCursor,
      ) ?? conversationCapsule?.sourceCursor,
      conversationCapsuleVersion: optionalNumber(
        cursors?.conversation_capsule_version ?? cursors?.conversationCapsuleVersion,
      ) ?? conversationCapsule?.version,
      workspaceCapsuleSourceCursor: asString(
        cursors?.workspace_capsule_source_cursor ?? cursors?.workspaceCapsuleSourceCursor,
      ) ?? workspaceCapsule?.sourceCursor,
      workspaceCapsuleVersion: optionalNumber(
        cursors?.workspace_capsule_version ?? cursors?.workspaceCapsuleVersion,
      ) ?? workspaceCapsule?.version,
    },
  };
}

function normalizeMessageContent(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function messageFingerprint(message: FastContextMessageHint): string {
  return `${message.role}:${normalizeMessageContent(message.content)}`;
}

function normalizeHint(value: FastContextMessageHint): { role: "user" | "assistant"; content: string } | undefined {
  const role = value.role === "user" || value.role === "assistant" ? value.role : undefined;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  return role && content ? { role, content } : undefined;
}

export function mergeServerAuthoritativeMessages(args: {
  readonly canonicalMessages: readonly FastSnapshotMessage[];
  readonly clientMessages: readonly FastContextMessageHint[];
  readonly currentUserMessage?: string;
  readonly limit?: number;
}): readonly { role: "user" | "assistant"; content: string }[] {
  const limit = positiveInteger(args.limit, FAST_CONTEXT_SNAPSHOT_MESSAGE_LIMIT, 1, 100);
  const canonical = args.canonicalMessages
    .map((message) => normalizeHint({ role: message.role, content: message.content }))
    .filter((message): message is { role: "user" | "assistant"; content: string } => Boolean(message));
  const client = args.clientMessages
    .map(normalizeHint)
    .filter((message): message is { role: "user" | "assistant"; content: string } => Boolean(message));

  const canonicalFingerprints = new Set(canonical.map(messageFingerprint));
  let lastClientOverlap = -1;
  for (let index = client.length - 1; index >= 0; index -= 1) {
    if (canonicalFingerprints.has(messageFingerprint(client[index]))) {
      lastClientOverlap = index;
      break;
    }
  }

  const clientTail = canonical.length === 0
    ? client
    : lastClientOverlap >= 0
      ? client.slice(lastClientOverlap + 1)
      : [];
  const merged = collapseAdjacentDuplicateMessages([
    ...canonical,
    ...clientTail.filter((message) => !canonicalFingerprints.has(messageFingerprint(message))),
  ]) as readonly { role: "user" | "assistant"; content: string }[];

  const currentFingerprint = normalizeMessageContent(args.currentUserMessage ?? "");
  const withoutCurrent = [...merged];
  while (
    currentFingerprint &&
    withoutCurrent.length > 0 &&
    withoutCurrent[withoutCurrent.length - 1].role === "user" &&
    normalizeMessageContent(withoutCurrent[withoutCurrent.length - 1].content) === currentFingerprint
  ) {
    withoutCurrent.pop();
  }
  return withoutCurrent.slice(-limit);
}

export function collectSourceDocumentIds(fileReferences: readonly Record<string, unknown>[] | undefined): readonly string[] {
  if (!fileReferences) return [];
  const ids = fileReferences.flatMap((reference) => {
    const value = reference.sourceDocumentId ?? reference.source_document_id ?? reference.document_id;
    return typeof value === "string" && UUID_PATTERN.test(value) ? [value] : [];
  });
  return [...new Set(ids)];
}

function logSnapshot(event: string, details: Record<string, unknown>): void {
  console.info(JSON.stringify({ scope: "fast_context_snapshot", event, ...details }));
}

export async function fetchFastContextSnapshot(args: {
  readonly userDb?: SupabaseClient | any;
  readonly ownerUserId?: string;
  readonly conversationId?: string;
  readonly query: string;
  readonly clientRequestId?: string;
  readonly sourceDocumentIds?: readonly string[];
  readonly timeoutMs?: number;
}): Promise<FastContextSnapshotFetchResult> {
  const timeoutMs = resolveFastContextSnapshotTimeoutMs(args.timeoutMs);
  const startedAt = Date.now();
  if (isGuestIdentity(args.ownerUserId) || !args.userDb || !args.conversationId) {
    return { status: "skipped", elapsedMs: Date.now() - startedAt, timeoutMs };
  }

  const rpcPromise = Promise.resolve(args.userDb.rpc("get_fast_context_snapshot", {
    p_owner_user_id: args.ownerUserId,
    p_conversation_id: args.conversationId,
    p_query: args.query,
    p_client_request_id: args.clientRequestId?.trim() || null,
    p_source_document_ids: args.sourceDocumentIds ?? [],
    p_message_limit: FAST_CONTEXT_SNAPSHOT_MESSAGE_LIMIT,
    p_memory_limit: FAST_CONTEXT_SNAPSHOT_MEMORY_LIMIT,
    p_source_limit: FAST_CONTEXT_SNAPSHOT_SOURCE_LIMIT,
  }))
    .then((result: { data?: unknown; error?: { code?: string; message?: string } | null }) => ({
      kind: "rpc" as const,
      result,
    }))
    .catch((error: unknown) => ({ kind: "exception" as const, error }));

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const outcome = await Promise.race([rpcPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  const elapsedMs = Date.now() - startedAt;

  if (outcome.kind === "timeout") {
    logSnapshot("timeout", { elapsed_ms: elapsedMs, timeout_ms: timeoutMs });
    return { status: "timeout", elapsedMs, timeoutMs, errorCode: "snapshot_timeout" };
  }
  if (outcome.kind === "exception") {
    const errorCode = outcome.error instanceof Error ? outcome.error.name : "snapshot_exception";
    logSnapshot("degraded", { elapsed_ms: elapsedMs, error_code: errorCode });
    return { status: "degraded", elapsedMs, timeoutMs, errorCode };
  }
  if (outcome.result.error) {
    const errorCode = outcome.result.error.code || "snapshot_rpc_error";
    logSnapshot("degraded", { elapsed_ms: elapsedMs, error_code: errorCode });
    return { status: "degraded", elapsedMs, timeoutMs, errorCode };
  }

  const snapshot = normalizeFastContextSnapshot(outcome.result.data);
  if (!snapshot || snapshot.schemaVersion !== FAST_CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
    logSnapshot("degraded", { elapsed_ms: elapsedMs, error_code: "snapshot_invalid" });
    return { status: "degraded", elapsedMs, timeoutMs, errorCode: "snapshot_invalid" };
  }
  logSnapshot("available", {
    elapsed_ms: elapsedMs,
    messages: snapshot.messages.length,
    memories: snapshot.memories.length,
    source_documents: snapshot.sourceDocuments.length,
    conversation_capsule_version: snapshot.conversationCapsule?.version ?? null,
    workspace_capsule_version: snapshot.workspaceCapsule?.version ?? null,
  });
  return { status: "available", elapsedMs, timeoutMs, snapshot };
}
