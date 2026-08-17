import type { GenerationEventSink, GenerationExecutorHandler } from "./generationRunner";

/**
 * Transport-neutral chat execution boundary.
 *
 * Express/HTTP code registers the current chat pipeline here during bootstrap,
 * but the generation runner itself depends only on this executor contract.
 * This makes the executor the single seam for the eventual full extraction of
 * routing/model/tool execution from serverLegacy.ts.
 */
let registeredExecutor: GenerationExecutorHandler | null = null;

export function registerChatGenerationExecutor(handler: GenerationExecutorHandler): void {
  registeredExecutor = handler;
}

export function getChatGenerationExecutor(): GenerationExecutorHandler | null {
  return registeredExecutor;
}

export async function executeChatGeneration(
  request: Parameters<GenerationExecutorHandler>[0],
  sink: GenerationEventSink,
): Promise<void> {
  const executor = registeredExecutor;
  if (!executor) {
    throw Object.assign(new Error("Chat generation executor is unavailable"), {
      code: "generation_executor_unavailable",
    });
  }

  await Promise.resolve(executor(request, sink, (error) => {
    if (error) throw error;
  }));
  await sink.flush();
}

export const CHAT_GENERATION_EXECUTOR_CONTRACT =
  "Generation execution is transport-neutral; the HTTP/SSE layer may register the implementation but never owns its lifetime.";
