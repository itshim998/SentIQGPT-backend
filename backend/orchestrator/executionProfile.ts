export type ExecutionMode = "fast" | "intuitive";

export type ExecutionProfile = {
  readonly mode: ExecutionMode;
  readonly clarification: {
    readonly enabled: boolean;
  };
  readonly context: {
    readonly compressConversation: boolean;
    readonly cloudMemories: boolean;
    readonly semanticMemorySearch: boolean;
    readonly priorConversationRecall: boolean;
  };
  readonly reflection: {
    readonly enabled: boolean;
  };
  readonly persistence: {
    readonly blockOnAssistantWrite: boolean;
    readonly blockOnMemoryEmbedding: boolean;
  };
  readonly streaming: {
    readonly preferDirectStream: boolean;
  };
};

export const FAST_PROFILE: ExecutionProfile = {
  mode: "fast",
  clarification: { enabled: false },
  context: {
    compressConversation: false,
    cloudMemories: false,
    semanticMemorySearch: false,
    priorConversationRecall: false,
  },
  reflection: { enabled: false },
  persistence: {
    blockOnAssistantWrite: false,
    blockOnMemoryEmbedding: false,
  },
  streaming: {
    preferDirectStream: true,
  },
};

export const INTUITIVE_PROFILE: ExecutionProfile = {
  mode: "intuitive",
  clarification: { enabled: true },
  context: {
    compressConversation: true,
    cloudMemories: true,
    semanticMemorySearch: true,
    priorConversationRecall: true,
  },
  reflection: { enabled: true },
  persistence: {
    blockOnAssistantWrite: true,
    blockOnMemoryEmbedding: true,
  },
  streaming: {
    preferDirectStream: false,
  },
};

export function normalizeExecutionMode(value: unknown): ExecutionMode {
  return value === "intuitive" ? "intuitive" : "fast";
}

export function resolveExecutionProfile(value: unknown): ExecutionProfile {
  return normalizeExecutionMode(value) === "intuitive" ? INTUITIVE_PROFILE : FAST_PROFILE;
}

export function isFastExecutionProfile(profile: ExecutionProfile): boolean {
  return profile.mode === "fast";
}
