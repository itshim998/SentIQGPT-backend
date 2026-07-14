import {
  MAX_TOOL_ARGUMENT_BYTES,
  type AssistantTurn,
  type ProviderDelta,
  type RawModelToolCall,
  type SentIQToolName,
  type ToolAvailabilityContext,
  isSentIQToolName,
  normalizeAssistantTurn,
  validateModelToolCalls,
} from "../orchestrator/toolContract";

export type RawProviderDelta =
  | { readonly kind: "text_delta"; readonly text?: unknown }
  | { readonly kind: "tool_call_start"; readonly id?: unknown; readonly name?: unknown; readonly index?: unknown }
  | { readonly kind: "tool_argument_delta"; readonly id?: unknown; readonly text?: unknown; readonly index?: unknown }
  | { readonly kind: "done"; readonly finishReason?: unknown };

export function normalizeBufferedProviderResult(
  raw: unknown,
  context: ToolAvailabilityContext,
  allowedTools?: readonly SentIQToolName[],
): AssistantTurn {
  return normalizeAssistantTurn(raw, context, allowedTools);
}

type PendingCall = {
  id: string;
  name: SentIQToolName;
  index: number;
  argumentsText: string;
};

export class ToolCallStreamAccumulator {
  private readonly pendingById = new Map<string, PendingCall>();
  private readonly pendingByIndex = new Map<number, PendingCall>();
  private emittedText = false;
  private startedToolCall = false;
  private finished = false;

  constructor(
    private readonly context: ToolAvailabilityContext,
    private readonly allowedTools: readonly SentIQToolName[],
  ) {}

  push(raw: RawProviderDelta): readonly ProviderDelta[] {
    if (this.finished) throw new Error("Provider emitted data after the stream completed.");
    switch (raw.kind) {
      case "text_delta": {
        if (this.startedToolCall) throw new Error("Provider mixed assistant text with tool calls.");
        if (typeof raw.text !== "string" || !raw.text) return [];
        this.emittedText = true;
        return [{ kind: "text_delta", text: raw.text }];
      }
      case "tool_call_start": {
        if (this.emittedText) throw new Error("Provider selected a tool after visible text.");
        const id = typeof raw.id === "string" ? raw.id.trim() : "";
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0
          ? raw.index
          : this.pendingById.size;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Tool call ID is malformed.");
        if (!isSentIQToolName(name)) throw new Error(`Unknown SentIQ tool: ${name || "(missing)"}`);
        if (!this.allowedTools.includes(name)) throw new Error(`SentIQ tool is unavailable: ${name}`);
        if (this.pendingById.has(id) || this.pendingByIndex.has(index)) throw new Error("Duplicate tool call ID or index.");
        const pending: PendingCall = { id, name, index, argumentsText: "" };
        this.pendingById.set(id, pending);
        this.pendingByIndex.set(index, pending);
        this.startedToolCall = true;
        return [{ kind: "tool_call_start", id, name, index }];
      }
      case "tool_argument_delta": {
        if (this.emittedText) throw new Error("Provider emitted tool arguments after visible text.");
        const id = typeof raw.id === "string" ? raw.id.trim() : "";
        const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0
          ? raw.index
          : -1;
        const pending = (id ? this.pendingById.get(id) : undefined) ?? this.pendingByIndex.get(index);
        if (!pending) throw new Error("Tool argument delta has no matching tool call.");
        if (id && index >= 0 && (pending.id !== id || pending.index !== index)) {
          throw new Error("Tool argument delta ID and index do not match.");
        }
        if (typeof raw.text !== "string") throw new Error("Tool argument delta is malformed.");
        pending.argumentsText += raw.text;
        if (Buffer.byteLength(pending.argumentsText, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
          throw new Error("Tool arguments exceed the allowed size.");
        }
        return [{ kind: "tool_argument_delta", id: pending.id, text: raw.text, index: pending.index }];
      }
      case "done": {
        this.finished = true;
        const output: ProviderDelta[] = [];
        if (this.startedToolCall) {
          const rawCalls: RawModelToolCall[] = [...this.pendingByIndex.values()]
            .sort((left, right) => left.index - right.index)
            .map((pending) => ({
              id: pending.id,
              name: pending.name,
              arguments: pending.argumentsText,
              index: pending.index,
            }));
          const calls = validateModelToolCalls(rawCalls, this.context, this.allowedTools);
          output.push({ kind: "tool_calls_complete", calls });
        }
        output.push({
          kind: "done",
          ...(typeof raw.finishReason === "string" && raw.finishReason ? { finishReason: raw.finishReason } : {}),
        });
        return output;
      }
      default:
        throw new Error("Provider stream delta kind is unsupported.");
    }
  }
}
