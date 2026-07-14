import type { ExecutionMode } from "./executionProfile";

export interface CapabilityModelSelection {
  readonly model: string;
  readonly source: "capability";
  readonly fallback_reason?: string;
}

export type ImageModelPreference = "zimage" | "wan-image";

interface CapabilityContext {
  readonly hasImage?: boolean;
  readonly hasFile?: boolean;
  readonly fileContent?: string;
  readonly fileNames?: string[];
}

export async function selectModelForCapabilities(args: {
  readonly query: string;
  readonly options?: CapabilityContext;
  readonly executionMode?: ExecutionMode;
  readonly userId?: string;
  readonly isGuest?: boolean;
  readonly signal?: AbortSignal;
}): Promise<CapabilityModelSelection> {
  void args.query;
  void args.executionMode;
  void args.userId;
  void args.isGuest;
  void args.signal;

  const requiresMultimodalContext = Boolean(args.options?.hasImage || args.options?.hasFile);
  return {
    model: requiresMultimodalContext ? "gemini-search" : "gpt-oss-120b",
    source: "capability",
    fallback_reason: requiresMultimodalContext ? "input_capability" : "default_text_model",
  };
}

export async function selectImageModelForCapabilities(): Promise<ImageModelPreference | undefined> {
  return undefined;
}
