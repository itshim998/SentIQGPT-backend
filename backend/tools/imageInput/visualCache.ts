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

export interface AssetBaseCacheItem {
  readonly pages: readonly import("./types").PageVisualEvidence[];
  readonly relevant_text: string;
  readonly visual_findings: string;
}

export function computeAssetBaseCacheKey(args: {
  readonly sha256: string;
  readonly model: string;
  readonly analysisVersion?: number;
  readonly promptVersion?: number;
}): string {
  const parts = [
    args.sha256,
    args.model,
    String(args.analysisVersion ?? VISUAL_ANALYSIS_VERSION),
    String(args.promptVersion ?? VISUAL_PROMPT_VERSION),
  ];
  return createHash("sha256").update(parts.join(":")).digest("hex");
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
const assetBaseCache = new Map<string, AssetBaseCacheItem>();

export function getCachedVisualAnalysis(cacheKey: string): ImageInputResult | undefined {
  return memoryVisualCache.get(cacheKey);
}

export function setCachedVisualAnalysis(cacheKey: string, result: ImageInputResult): void {
  memoryVisualCache.set(cacheKey, result);
}

export function getCachedAssetBase(baseKey: string): AssetBaseCacheItem | undefined {
  return assetBaseCache.get(baseKey);
}

export function setCachedAssetBase(baseKey: string, item: AssetBaseCacheItem): void {
  assetBaseCache.set(baseKey, item);
}

export function clearVisualAnalysisCacheForTests(): void {
  memoryVisualCache.clear();
  assetBaseCache.clear();
}
