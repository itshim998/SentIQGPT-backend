import { estimateTextTokens } from "../orchestrator/contextBudgetManager";

export const SOURCE_PARENT_TARGET_TOKENS = 1_100;
export const SOURCE_CHILD_TARGET_TOKENS = 350;
export const SOURCE_CHILD_OVERLAP_TOKENS = 64;

export interface SourceParentChunk {
  readonly index: number;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly heading?: string;
  readonly path?: string;
  readonly pageNumber?: number;
  readonly contextPrefix?: string;
}

export interface SourceChildChunk extends SourceParentChunk {
  readonly parentIndex: number;
}

export interface ParentChildSourceChunks {
  readonly parents: readonly SourceParentChunk[];
  readonly children: readonly SourceChildChunk[];
}

function findBoundary(text: string, start: number, end: number): number {
  if (end >= text.length) return text.length;
  const minimum = start + Math.floor((end - start) * 0.72);
  const region = text.slice(minimum, end);
  let boundary = -1;
  for (const pattern of [/\n\s*\n/g, /\n/g, /[.!?]\s+/g, /\s+/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(region)) !== null) {
      boundary = minimum + match.index + match[0].length;
    }
    if (boundary > start) return boundary;
  }
  return end;
}

function findChunkEnd(text: string, start: number, targetTokens: number): number {
  let low = start + 1;
  // Conservative token estimation never needs an unbounded search window.
  // Keeping this local avoids repeatedly slicing the entire remainder of a
  // multi-megabyte source for every chunk.
  let high = Math.min(text.length, start + targetTokens * 8);
  let best = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTextTokens(text.slice(start, mid)) <= targetTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return findBoundary(text, start, best);
}

function findOverlapStart(text: string, start: number, end: number, overlapTokens: number): number {
  if (overlapTokens <= 0) return end;
  let low = start;
  let high = end;
  let best = end;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTextTokens(text.slice(mid, end)) <= overlapTokens) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return best;
}

function splitByEstimatedTokens(text: string, targetTokens: number, overlapTokens = 0): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (estimateTextTokens(normalized) <= targetTokens) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.max(start + 1, findChunkEnd(normalized, start, targetTokens));
    const content = normalized.slice(start, end).trim();
    if (content) chunks.push(content);
    if (end >= normalized.length) break;
    const overlapStart = findOverlapStart(normalized, start, end, overlapTokens);
    start = overlapStart > start ? overlapStart : end;
  }
  return chunks;
}

function inferHeading(content: string): string | undefined {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 12);
  const heading = lines.find((line) => /^#{1,6}\s+/.test(line))
    ?? lines.find((line) => line.length <= 120 && /:$/.test(line))
    ?? lines.find((line) => line.length <= 100 && /^[A-Z][A-Z0-9 _-]{4,}$/.test(line));
  return heading?.replace(/^#{1,6}\s+/, "").replace(/:$/, "").trim() || undefined;
}

export function chunkSourceText(args: {
  readonly text: string;
  readonly title: string;
  readonly path?: string;
  readonly pageNumber?: number;
}): ParentChildSourceChunks {
  const parentTexts = splitByEstimatedTokens(args.text, SOURCE_PARENT_TARGET_TOKENS);
  const parents: SourceParentChunk[] = [];
  const children: SourceChildChunk[] = [];
  let childIndex = 0;

  parentTexts.forEach((content, parentIndex) => {
    const heading = inferHeading(content);
    const contextPrefix = [args.title, args.path, heading].filter(Boolean).join(" > ");
    parents.push({
      index: parentIndex,
      content,
      tokenEstimate: estimateTextTokens(content),
      heading,
      path: args.path,
      pageNumber: args.pageNumber,
      contextPrefix: contextPrefix || undefined,
    });
    splitByEstimatedTokens(content, SOURCE_CHILD_TARGET_TOKENS, SOURCE_CHILD_OVERLAP_TOKENS)
      .forEach((childContent) => {
        children.push({
          index: childIndex++,
          parentIndex,
          content: childContent,
          tokenEstimate: estimateTextTokens(childContent),
          heading,
          path: args.path,
          pageNumber: args.pageNumber,
          contextPrefix: contextPrefix || undefined,
        });
      });
  });

  return { parents, children };
}
