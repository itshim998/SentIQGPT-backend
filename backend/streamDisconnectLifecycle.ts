export interface StreamRequestLifecycle {
  readonly complete: boolean;
  once(event: "close", listener: () => void): unknown;
}

export interface StreamResponseLifecycle {
  readonly writableEnded: boolean;
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

  // IncomingMessage "close" describes the inbound request lifecycle. A complete
  // body is normal and must not interrupt an outbound response that is still streaming.
  args.request.once("close", () => {
    if (args.request.complete) return;
    markDisconnected();
  });
  args.response.once("close", () => {
    if (args.response.writableEnded) return;
    markDisconnected();
  });

  return {
    isDisconnected: () => disconnected,
  };
}
