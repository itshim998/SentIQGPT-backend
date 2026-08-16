export interface StreamRequestLifecycle {
  readonly complete: boolean;
  readonly __sentiqGenerationDetached?: boolean;
  once(event: "close" | "sentiq-generation-cancel", listener: () => void): unknown;
}

export interface StreamResponseLifecycle {
  readonly writableEnded: boolean;
  readonly __sentiqGenerationDetached?: boolean;
  once(event: "close", listener: () => void): unknown;
}

export interface StreamDisconnectLifecycle {
  isDisconnected(): boolean;
}

export function attachStreamDisconnectLifecycle(args: {
  request: StreamRequestLifecycle;
  response: StreamResponseLifecycle;
  isResponseCompleted: () => boolean;
  onDisconnect: () => void;
}): StreamDisconnectLifecycle {
  let disconnected = false;

  const markDisconnected = () => {
    if (disconnected || args.isResponseCompleted()) return;
    disconnected = true;
    args.onDisconnect();
  };

  // A generation-owned transport is intentionally detached from the model
  // lifecycle. Closing an SSE subscriber only removes that subscriber.
  const transportDetached = () => Boolean(args.request.__sentiqGenerationDetached || args.response.__sentiqGenerationDetached);

  args.request.once("close", () => {
    if (args.request.complete || transportDetached()) return;
    markDisconnected();
  });

  args.response.once("close", () => {
    if (args.response.writableEnded || transportDetached()) return;
    markDisconnected();
  });

  // Explicit product-level cancellation remains connected to the existing
  // request AbortController without treating ordinary transport close as a
  // cancellation signal.
  args.request.once("sentiq-generation-cancel", () => {
    markDisconnected();
  });

  return {
    isDisconnected: () => disconnected,
  };
}
