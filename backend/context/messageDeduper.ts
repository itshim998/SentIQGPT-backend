export type DedupableMessage = {
  readonly role?: string;
  readonly content?: string;
  readonly created_at?: string;
  readonly timestamp?: string;
};

const DEFAULT_DUPLICATE_WINDOW_MS = 90_000;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function readMessageTime(message: DedupableMessage): number | null {
  const raw = typeof message.created_at === "string" && message.created_at
    ? message.created_at
    : typeof message.timestamp === "string" && message.timestamp
      ? message.timestamp
      : "";
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function collapseAdjacentDuplicateMessages<T extends DedupableMessage>(
  messages: readonly T[] | null | undefined,
  duplicateWindowMs: number = DEFAULT_DUPLICATE_WINDOW_MS,
): T[] {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? [...messages] : [];
  }

  const collapsed: T[] = [];
  for (const message of messages) {
    const last = collapsed[collapsed.length - 1];
    if (!last) {
      collapsed.push(message);
      continue;
    }

    const sameRole = normalizeText(last.role) === normalizeText(message.role);
    const sameContent = normalizeText(last.content) === normalizeText(message.content);
    if (!sameRole || !sameContent) {
      collapsed.push(message);
      continue;
    }

    const lastTime = readMessageTime(last);
    const nextTime = readMessageTime(message);
    if (lastTime === null || nextTime === null) {
      continue;
    }

    if (Math.abs(nextTime - lastTime) <= duplicateWindowMs) {
      continue;
    }

    collapsed.push(message);
  }

  return collapsed;
}
