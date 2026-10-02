import type { ExecutionMode } from "./executionProfile";
import type { ImageModelPreference } from "../tools/imageGeneration/types";

export interface CapabilityModelSelection {
  readonly provider: "groq" | "gemini";
  readonly model: string;
  readonly source: "capability";
  readonly fallback_reason?: string;
}

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

  // The main conversation text model remains provider-neutral (Groq / gpt-oss-120b).
  // Visual understanding is executed via the `image_input` tool calling into Gemini Flash-Lite,
  // allowing the main model to receive structured visual evidence and continue synthesis.
  return {
    provider: "groq",
    model: "gpt-oss-120b",
    source: "capability",
    fallback_reason: "default_text_model",
  };
}

export async function selectImageModelForCapabilities(): Promise<ImageModelPreference | undefined> {
  return undefined;
}
