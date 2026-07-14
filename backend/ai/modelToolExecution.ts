import {
  validateSingleAutomaticToolCall,
  type AssistantTurn,
  type ProviderDelta,
  type SentIQToolName,
  type ToolAvailabilityContext,
  type ToolLifecycleEvent,
  type ValidatedToolCall,
} from "../orchestrator/toolContract";

export class AutomaticToolDispatchError extends Error {
  constructor(
    readonly call: ValidatedToolCall,
    readonly events: readonly ToolLifecycleEvent[],
    readonly cause: unknown,
  ) {
    super("Automatic SentIQ tool execution failed.");
    this.name = "AutomaticToolDispatchError";
  }
}

export async function dispatchAutomaticModelToolCall<T>(args: {
  calls: readonly ValidatedToolCall[];
  context: ToolAvailabilityContext;
  allowedTools: readonly SentIQToolName[];
  executeWebSurf: (query: string, call: ValidatedToolCall) => Promise<T>;
  executeImage: (prompt: string, call: ValidatedToolCall) => Promise<T>;
  executeChart: (request: string, call: ValidatedToolCall) => Promise<T>;
  executeFile: (request: string, format: string | undefined, call: ValidatedToolCall) => Promise<T>;
  executeMemory: (content: string, type: "identity" | "preference" | "project", scope: "global" | "chat", call: ValidatedToolCall) => Promise<T>;
  isFailure?: (result: T, call: ValidatedToolCall) => boolean;
  onLifecycleEvent?: (event: ToolLifecycleEvent) => void | Promise<void>;
}): Promise<{ call: ValidatedToolCall; result: T; events: readonly ToolLifecycleEvent[] }> {
  const call = validateSingleAutomaticToolCall(args.calls, args.context, args.allowedTools);
  const events: ToolLifecycleEvent[] = [
    { type: "tool_selected", tool: call.name, call_id: call.id },
    { type: "tool_started", tool: call.name, call_id: call.id },
  ];
  for (const event of events) await args.onLifecycleEvent?.(event);
  try {
    let result: T;
    switch (call.name) {
      case "web_surf":
        result = await args.executeWebSurf(String(call.arguments.query), call);
        break;
      case "image_gen":
        result = await args.executeImage(String(call.arguments.prompt), call);
        break;
      case "chart_gen":
        result = await args.executeChart(String(call.arguments.request), call);
        break;
      case "file_gen":
        result = await args.executeFile(
          String(call.arguments.request),
          typeof call.arguments.format === "string" ? call.arguments.format : undefined,
          call,
        );
        break;
      case "memory_update":
        result = await args.executeMemory(
          String(call.arguments.content),
          call.arguments.type as "identity" | "preference" | "project",
          call.arguments.scope as "global" | "chat",
          call,
        );
        break;
    }
    const terminalEvent: ToolLifecycleEvent = args.isFailure?.(result, call)
      ? { type: "tool_error", tool: call.name, call_id: call.id, code: "execution_failed" }
      : { type: "tool_result", tool: call.name, call_id: call.id };
    events.push(terminalEvent);
    await args.onLifecycleEvent?.(terminalEvent);
    return { call, result, events };
  } catch (error) {
    const terminalEvent: ToolLifecycleEvent = {
      type: "tool_error",
      tool: call.name,
      call_id: call.id,
      code: "execution_failed",
    };
    events.push(terminalEvent);
    await args.onLifecycleEvent?.(terminalEvent);
    throw new AutomaticToolDispatchError(call, events, error);
  }
}

export async function consumeModelTurnStream(
  stream: ReadableStream<ProviderDelta>,
  onText: (text: string) => void | Promise<void>,
): Promise<AssistantTurn> {
  const reader = stream.getReader();
  let text = "";
  let calls: readonly ValidatedToolCall[] | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value?.kind === "done") break;
      if (value.kind === "text_delta") {
        text += value.text;
        await onText(value.text);
      } else if (value.kind === "tool_calls_complete") {
        calls = value.calls;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (calls) return { kind: "tool_calls", calls };
  return { kind: "assistant_text", text };
}
