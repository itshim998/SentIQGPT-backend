import { createHash } from "node:crypto";
import type { ImageInputResult } from "./types";

export const VISUAL_ANALYSIS_VERSION = 1;
export const VISUAL_PROMPT_VERSION = 1;

export interface VisualCacheKeyArgs {
  readonly sha256: string;
  readonly model: string;
  readonly analysisVersion?: number;
  readonly promptVersion?: number;
  readonly requestSpecificQuery?: string;
}

export function computeVisualAnalysisCacheKey(args: VisualCacheKeyArgs): string {
  const parts = [
    args.sha256,
    args.model,
    String(args.analysisVersion ?? VISUAL_ANALYSIS_VERSION),
    String(args.promptVersion ?? VISUAL_PROMPT_VERSION),
    (args.requestSpecificQuery || "").trim().toLowerCase(),
  ];
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

const memoryVisualCache = new Map<string, ImageInputResult>();

export function getCachedVisualAnalysis(cacheKey: string): ImageInputResult | undefined {
  return memoryVisualCache.get(cacheKey);
}

export function setCachedVisualAnalysis(cacheKey: string, result: ImageInputResult): void {
  memoryVisualCache.set(cacheKey, result);
}

export function clearVisualAnalysisCacheForTests(): void {
  memoryVisualCache.clear();
}
