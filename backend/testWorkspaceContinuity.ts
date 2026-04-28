import assert from "assert/strict";
import { buildChatPrompt } from "./ai/PromptBuilders";
import {
  fetchPriorConversationRecallEvidence,
  isExplicitPriorConversationRecallQuery,
} from "./context/contextBuilder";
import { collapseAdjacentDuplicateMessages } from "./context/messageDeduper";
import { insertConversationMessage } from "./services/conversationService";

type ConversationRow = {
  id: string;
  user_id: string;
  created_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  client_request_id?: string | null;
};

class MockQuery<T extends Record<string, any>> {
  private filters: Array<(row: T) => boolean> = [];
  private orderColumn = "";
  private ascending = true;
  private limitCount = Number.POSITIVE_INFINITY;

  constructor(private readonly rows: T[]) {}

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.ascending = options?.ascending ?? true;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  select(_columns: string): this {
    return this;
  }

  async maybeSingle(): Promise<{ data: T | null; error: null }> {
    const items = this.execute();
    return { data: items[0] ?? null, error: null };
  }

  then<TResult1 = { data: T[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.execute(), error: null }).then(onfulfilled, onrejected);
  }

  private execute(): T[] {
    let items = [...this.rows];
    for (const filter of this.filters) {
      items = items.filter(filter);
    }
    if (this.orderColumn) {
      items.sort((left, right) => {
        const leftValue = String(left[this.orderColumn] ?? "");
        const rightValue = String(right[this.orderColumn] ?? "");
        if (leftValue === rightValue) return 0;
        const comparison = leftValue < rightValue ? -1 : 1;
        return this.ascending ? comparison : -comparison;
      });
    }
    return items.slice(0, this.limitCount);
  }
}

class MockConversationDb {
  readonly conversations: ConversationRow[] = [];
  readonly messages: MessageRow[] = [];

  from(table: string) {
    if (table === "conversations") {
      return {
        select: (_columns: string) => new MockQuery(this.conversations),
      };
    }

    if (table === "messages") {
      return {
        select: (_columns: string) => new MockQuery(this.messages),
        insert: (payload: Omit<MessageRow, "id" | "created_at"> & { created_at?: string }) => {
          const isDuplicateUserInsert = payload.role === "user"
            && !!payload.client_request_id
            && this.messages.some((message) =>
              message.role === "user"
              && message.conversation_id === payload.conversation_id
              && message.client_request_id === payload.client_request_id,
            );

          if (isDuplicateUserInsert) {
            return {
              select: (_columns: string) => ({
                maybeSingle: async () => ({
                  data: null,
                  error: { code: "23505", message: "duplicate key value violates unique constraint" },
                }),
              }),
            };
          }

          const row: MessageRow = {
            id: `msg-${this.messages.length + 1}`,
            conversation_id: payload.conversation_id,
            role: payload.role,
            content: payload.content,
            created_at: payload.created_at || new Date(Date.UTC(2026, 3, 28, 12, this.messages.length)).toISOString(),
            client_request_id: payload.client_request_id ?? null,
          };
          this.messages.push(row);
          return {
            select: (_columns: string) => ({
              maybeSingle: async () => ({ data: row, error: null }),
            }),
          };
        },
      };
    }

    throw new Error(`Unexpected table requested in test mock: ${table}`);
  }
}

async function main(): Promise<void> {
  const userId = "22222222-2222-4222-8222-222222222222";
  const db = new MockConversationDb();

  db.conversations.push(
    { id: "conv-current", user_id: userId, created_at: "2026-04-28T12:30:00.000Z" },
    { id: "conv-virat", user_id: userId, created_at: "2026-04-27T09:00:00.000Z" },
    { id: "conv-other", user_id: userId, created_at: "2026-04-26T09:00:00.000Z" },
  );
  db.messages.push(
    {
      id: "msg-a",
      conversation_id: "conv-virat",
      role: "user",
      content: "Virat Kohli current stats in IPL this season",
      created_at: "2026-04-27T09:05:00.000Z",
      client_request_id: null,
    },
    {
      id: "msg-b",
      conversation_id: "conv-other",
      role: "user",
      content: "Tell me about Ajay Pal Sharma IPS",
      created_at: "2026-04-26T09:10:00.000Z",
      client_request_id: null,
    },
    {
      id: "msg-c",
      conversation_id: "conv-current",
      role: "assistant",
      content: "Current chat assistant reply should not be used as evidence",
      created_at: "2026-04-28T12:31:00.000Z",
      client_request_id: null,
    },
  );

  assert.equal(
    isExplicitPriorConversationRecallQuery("Do you remember me asking about Virat Kohli earlier?"),
    true,
    "explicit recall detector flags cross-chat continuity prompts",
  );
  assert.equal(
    isExplicitPriorConversationRecallQuery("Tell me Virat Kohli stats"),
    false,
    "ordinary topical prompts do not trigger prior-conversation recall",
  );

  const evidence = await fetchPriorConversationRecallEvidence({
    query: "Do you remember me asking about Virat Kohli earlier?",
    userDb: db as any,
    userId,
    currentConversationId: "conv-current",
  });
  assert.equal(evidence.length, 1, "recall evidence returns the matching prior user prompt");
  assert.match(evidence[0]?.content || "", /Virat Kohli/i, "recall evidence keeps the prior user prompt text");
  assert.equal(evidence[0]?.conversationId, "conv-virat", "current conversation is excluded from recall evidence");

  const noEvidence = await fetchPriorConversationRecallEvidence({
    query: "Do you remember me asking about Sachin Tendulkar earlier?",
    userDb: db as any,
    userId,
    currentConversationId: "conv-current",
  });
  assert.deepEqual(noEvidence, [], "no evidence is returned when there is no matching prior user prompt");

  const firstInsert = await insertConversationMessage(db as any, {
    conversationId: "conv-current",
    role: "user",
    content: "Ajay Pal Sharma IPS",
    clientRequestId: "req-123",
  });
  const secondInsert = await insertConversationMessage(db as any, {
    conversationId: "conv-current",
    role: "user",
    content: "Ajay Pal Sharma IPS",
    clientRequestId: "req-123",
  });
  assert.equal(firstInsert.error, null, "initial user message insert succeeds");
  assert.equal(secondInsert.error, null, "duplicate user message insert is treated as idempotent success");
  assert.equal(secondInsert.duplicate, true, "duplicate user message insert is reported as a duplicate");
  assert.equal(
    db.messages.filter((message) => message.client_request_id === "req-123").length,
    1,
    "client_request_id prevents duplicate user-message persistence",
  );

  const deduped = collapseAdjacentDuplicateMessages([
    { role: "user", content: "Ajay Pal Sharma IPS", created_at: "2026-04-28T12:00:00.000Z" },
    { role: "user", content: "Ajay Pal Sharma IPS", created_at: "2026-04-28T12:00:20.000Z" },
    { role: "assistant", content: "Let me check.", created_at: "2026-04-28T12:00:21.000Z" },
    { role: "user", content: "Ajay Pal Sharma IPS", created_at: "2026-04-28T12:05:00.000Z" },
  ]);
  assert.equal(deduped.length, 3, "adjacent transport duplicates collapse without deleting later legitimate repeats");
  assert.equal(deduped[2]?.content, "Ajay Pal Sharma IPS", "later repeated user prompt is preserved");

  const recallPrompt = buildChatPrompt({
    userMessage: "Do you remember me asking about Virat Kohli?",
    isExplicitRecallQuery: true,
    priorConversationEvidence: [{
      content: "Virat Kohli current stats in IPL this season",
      createdAt: "2026-04-27T09:05:00.000Z",
    }],
  });
  assert.match(recallPrompt.prompt, /PRIOR CONVERSATION EVIDENCE/i, "recall prompt includes a distinct evidence block");
  assert.match(
    recallPrompt.prompt,
    /cannot confirm it from the available history/i,
    "explicit recall prompts include the no-evidence provenance instruction",
  );

  console.log("PASS | workspace continuity recall, provenance, and duplicate guards passed.");
}

main().catch((error) => {
  console.error("FAIL | workspace continuity regression tests failed.");
  console.error(error);
  process.exit(1);
});
