// SentIQGPT — Context Composer
//
// Receives raw context components, ranks them by importance, enforces
// per-slot budgets via the Context Budget Manager, applies safe
// truncation rules, and assembles the final prompt string.
//
// Priority order (highest first):
//   1. user message
//   2. file context
//   3. conversation history
//   4. memory

import {
  allocateBudget,
  getContextBudget,
  truncateToBudget,
  type ContextBudgetProfile,
  type ContextParts,
} from "./contextBudgetManager";

// ── Per-item limits for collections ──
const MAX_MEMORY_ITEM_CHARS  = 2_000;

// ── Inputs accepted by the composer ──

export interface ComposerInput {
  systemPrompt: string;
  userMessage: string;
  conversation?: readonly { role: string; content: string }[];
  conversationSummary?: string;
  recallEvidence?: readonly { content: string; createdAt?: string }[];
  memories?: readonly { type: string; summary: string; importance?: number }[];
  fileReferences?: readonly { filename: string; extractedText: string }[];
  budgetProfile?: ContextBudgetProfile;
}

// ── Truncation helpers for individual items ──

/**
 * Truncate file content safely.
 * Files ≤ MAX_FILE_CHARS pass through; larger files keep the first and
 * last 20 000 chars with a truncation marker in between.
 */
function truncateFileContent(raw: string, maxFileChars: number): string {
  if (raw.length <= maxFileChars) return raw;
  const half = Math.floor(maxFileChars / 2);
  return (
    raw.slice(0, half) +
    "\n\n[... file truncated for analysis ...]\n\n" +
    raw.slice(-half)
  );
}

/**
 * Keep the **latest** conversation messages that fit within `budget`
 * characters.  Older messages are dropped first.
 */
function trimConversation(
  messages: readonly { role: string; content: string }[],
  summary: string | undefined,
  budget: number,
): string {
  const parts: string[] = [];
  let used = 0;

  // Summary goes first if present — it summarises the oldest context.
  if (summary) {
    const summaryBlock =
      "CONVERSATION SUMMARY (earlier discussion):\n  " + summary + "\n";
    if (summaryBlock.length < budget * 0.3) {
      parts.push(summaryBlock);
      used += summaryBlock.length;
    }
  }

  // Walk messages newest-first, collect until budget is exhausted.
  const kept: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = `  ${messages[i].role.toUpperCase()}: ${messages[i].content}`;
    if (used + line.length + 1 > budget) break;
    kept.unshift(line);
    used += line.length + 1;
  }

  if (kept.length > 0) {
    parts.push("CONVERSATION HISTORY:\n" + kept.join("\n") + "\n");
  }

  return parts.join("\n");
}

/**
 * Rank memories by importance (descending) and truncate each to
 * MAX_MEMORY_ITEM_CHARS.
 */
function buildMemoryBlock(
  memories: readonly { type: string; summary: string; importance?: number }[],
): string {
  if (memories.length === 0) return "";
  const sorted = [...memories].sort(
    (a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5),
  );
  const lines = sorted.map((m) => {
    const text = m.summary.length > MAX_MEMORY_ITEM_CHARS
      ? m.summary.slice(0, MAX_MEMORY_ITEM_CHARS) + "…"
      : m.summary;
    return `  [${m.type}] ${text}`;
  });
  return "SAVED MEMORY CONTEXT (durable facts the user asked you to remember):\n" + lines.join("\n") + "\n";
}

function buildRecallEvidenceBlock(
  evidence: readonly { content: string; createdAt?: string }[] | undefined,
): string {
  if (!evidence || evidence.length === 0) return "";
  const lines = evidence.map((item) => {
    const createdLabel = item.createdAt ? item.createdAt.slice(0, 10) : "unknown-date";
    const content = item.content.length > 600
      ? `${item.content.slice(0, 600).trimEnd()}...`
      : item.content;
    return `  [${createdLabel}] ${content}`;
  });
  return "PRIOR CONVERSATION EVIDENCE (earlier user prompts from other chats):\n" + lines.join("\n") + "\n";
}

/**
 * Build the file context block (all uploaded files combined).
 */
function buildFileBlock(
  files: readonly { filename: string; extractedText: string }[] | undefined,
  maxFileChars: number,
): string {
  if (!files || files.length === 0) return "";
  const parts: string[] = [];
  for (const file of files) {
    const content = truncateFileContent(file.extractedText || "", maxFileChars);
    const ext = file.filename.split(".").pop() || "txt";
    parts.push(
      `User uploaded file: ${file.filename}\n\n` +
      `FILE CONTENT START\n\n` +
      `\`\`\`${ext}\n${content}\n\`\`\`\n\n` +
      `FILE CONTENT END`,
    );
    console.log(
      `[ContextComposer] file "${file.filename}" chars=${(file.extractedText || "").length}` +
      ` → injected=${content.length}`,
    );
  }
  return parts.join("\n\n") + "\n";
}

// ── Main entry point ──

/**
 * Compose a budget-safe prompt from all context components.
 *
 * 1. Build each section independently.
 * 2. Per-slot budget enforcement via `allocateBudget()`.
 * 3. Final assembly — if the result exceeds the hard ceiling,
 *    force-truncate and log a warning.
 */
export function composeContext(input: ComposerInput): string {
  const budget = getContextBudget(input.budgetProfile ?? "standard");
  // ── 1. Build raw blocks ──
  const rawParts: ContextParts = {
    system: input.systemPrompt,
    user: `USER: ${input.userMessage}\n`,
    file: buildFileBlock(input.fileReferences, budget.file),
    conversation:
      buildRecallEvidenceBlock(input.recallEvidence) +
      trimConversation(
        input.conversation ?? [],
        input.conversationSummary,
        budget.conversation,
      ),
    memory: buildMemoryBlock(input.memories ?? []),
  };

  // ── 2. Enforce per-slot budgets ──
  const safe = allocateBudget(rawParts, budget);

  // ── 3. Log per-section sizes ──
  console.log(`[ContextComposer] system    chars=${safe.system.length}`);
  console.log(`[ContextComposer] conversation chars=${safe.conversation.length}`);
  console.log(`[ContextComposer] memory    chars=${safe.memory.length}`);
  console.log(`[ContextComposer] file      chars=${safe.file.length}`);
  console.log(`[ContextComposer] user      chars=${safe.user.length}`);

  // ── 4. Assemble in priority order ──
  // When files are present, they take priority over memory.
  // Order: system → user → file → conversation → memory
  // This ensures that if the hard ceiling truncates the end,
  // the file content and user question survive.
  const hasFiles = safe.file.length > 0;
  const assembled = hasFiles
    ? safe.system +
      safe.user +
      "\n" + safe.file +
      (safe.conversation ? "\n" + safe.conversation : "") +
      (safe.memory ? "\n" + safe.memory : "")
    : safe.system +
      (safe.memory   ? "\n" + safe.memory   : "") +
      (safe.conversation ? "\n" + safe.conversation : "") +
      safe.user;

  // ── 5. Hard ceiling guard ──
  let finalPrompt: string;
  if (assembled.length > budget.total) {
    console.warn(
      `[ContextGuard] prompt truncated to safe limit ` +
      `(${assembled.length} → ${budget.total})`,
    );
    finalPrompt = truncateToBudget(assembled, budget.total);
  } else {
    finalPrompt = assembled;
  }

  console.log(
    `[ContextComposer] final prompt size=${finalPrompt.length} profile=${input.budgetProfile ?? "standard"}`,
  );
  return finalPrompt;
}
