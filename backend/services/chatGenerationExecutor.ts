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
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    sink.once("finish", () => finish());
    sink.once("close", () => finish());
    try {
      const result = executor(request, sink, finish);
      if (result && typeof (result as any).then === "function") {
        (result as Promise<void>).then(() => finish(), finish);
      }
    } catch (error) {
      finish(error);
    }
  });
}

export const CHAT_GENERATION_EXECUTOR_CONTRACT =
  "Generation execution is transport-neutral; the HTTP/SSE layer may register the implementation but never owns its lifetime.";
