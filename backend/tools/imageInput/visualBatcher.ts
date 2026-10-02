import { type ResolutionConfig } from "./resolutionPolicy";

export interface BatchItem {
  readonly assetId: string;
  readonly pageNumber: number;
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly filename: string;
}

export interface VisualBatch {
  readonly batchIndex: number;
  readonly items: readonly BatchItem[];
  readonly estimatedTokens: number;
}

const DEFAULT_MAX_ITEMS_PER_BATCH = 8;
const DEFAULT_MAX_TOKENS_PER_BATCH = 8192;

export function partitionVisualBatches(
  items: readonly BatchItem[],
  resolution: ResolutionConfig,
  options: {
    readonly maxItemsPerBatch?: number;
    readonly maxTokensPerBatch?: number;
  } = {},
): VisualBatch[] {
  const maxItems = options.maxItemsPerBatch ?? DEFAULT_MAX_ITEMS_PER_BATCH;
  const maxTokens = options.maxTokensPerBatch ?? DEFAULT_MAX_TOKENS_PER_BATCH;
  const tokensPerItem = resolution.estimatedTokensPerPage;

  const batches: VisualBatch[] = [];
  let currentItems: BatchItem[] = [];
  let currentTokens = 0;
  let batchIndex = 0;

  for (const item of items) {
    if (
      currentItems.length >= maxItems ||
      (currentTokens + tokensPerItem > maxTokens && currentItems.length > 0)
    ) {
      batches.push({
        batchIndex,
        items: [...currentItems],
        estimatedTokens: currentTokens,
      });
      batchIndex += 1;
      currentItems = [];
      currentTokens = 0;
    }

    currentItems.push(item);
    currentTokens += tokensPerItem;
  }

  if (currentItems.length > 0) {
    batches.push({
      batchIndex,
      items: currentItems,
      estimatedTokens: currentTokens,
    });
  }

  return batches;
}
