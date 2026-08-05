import { createHash } from "node:crypto";

export type PdfPageExtractionStatus = "text" | "empty" | "failed";

export interface ExtractedPdfPage {
  readonly pageNumber: number;
  readonly text: string;
  readonly characterCount: number;
  readonly extractionStatus: PdfPageExtractionStatus;
  readonly errorType?: string;
}

export interface PendingPdfCanonicalSource {
  readonly ownerUserId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly previewText: string;
  readonly contentHash: string;
  readonly declaredPageCount: number;
  readonly pageCount: number;
  readonly pageLimitExceeded: boolean;
  readonly readPage: (pageNumber: number) => Promise<ExtractedPdfPage>;
  readonly destroy: () => Promise<void>;
}

interface PendingPdfCanonicalEntry {
  readonly source: PendingPdfCanonicalSource;
  readonly registeredAt: number;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING = 8;
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 30 * 60_000;
const MIN_PENDING = 1;
const MAX_PENDING = 32;

const pendingByKey = new Map<string, PendingPdfCanonicalEntry[]>();
let pendingCount = 0;

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function getRegistryTtlMs(): number {
  return readBoundedInteger(
    process.env.SENTIQ_PDF_CANONICAL_REGISTRY_TTL_MS,
    DEFAULT_TTL_MS,
    MIN_TTL_MS,
    MAX_TTL_MS,
  );
}

function getRegistryMaxPending(): number {
  return readBoundedInteger(
    process.env.SENTIQ_PDF_CANONICAL_REGISTRY_MAX_PENDING,
    DEFAULT_MAX_PENDING,
    MIN_PENDING,
    MAX_PENDING,
  );
}

export function buildPendingPdfCanonicalKey(args: {
  readonly ownerUserId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly previewText: string;
}): string {
  return createHash("sha256")
    .update(args.ownerUserId.trim().toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(args.filename, "utf8")
    .update("\0", "utf8")
    .update(String(args.sizeBytes), "utf8")
    .update("\0", "utf8")
    .update(args.previewText, "utf8")
    .digest("hex");
}

async function destroyQuietly(source: PendingPdfCanonicalSource): Promise<void> {
  try {
    await source.destroy();
  } catch {
    // Parser cleanup is best-effort. The registry must never throw from expiry.
  }
}

function removeEntry(key: string, entry: PendingPdfCanonicalEntry): boolean {
  const queue = pendingByKey.get(key);
  if (!queue) return false;
  const index = queue.indexOf(entry);
  if (index < 0) return false;
  queue.splice(index, 1);
  pendingCount = Math.max(0, pendingCount - 1);
  clearTimeout(entry.timer);
  if (queue.length === 0) pendingByKey.delete(key);
  return true;
}

function oldestEntry(): { key: string; entry: PendingPdfCanonicalEntry } | undefined {
  let selected: { key: string; entry: PendingPdfCanonicalEntry } | undefined;
  for (const [key, queue] of pendingByKey.entries()) {
    for (const entry of queue) {
      if (!selected || entry.registeredAt < selected.entry.registeredAt) {
        selected = { key, entry };
      }
    }
  }
  return selected;
}

function enforceCapacity(): void {
  const maximum = getRegistryMaxPending();
  while (pendingCount >= maximum) {
    const oldest = oldestEntry();
    if (!oldest) return;
    if (removeEntry(oldest.key, oldest.entry)) {
      void destroyQuietly(oldest.entry.source);
    }
  }
}

export function registerPendingPdfCanonicalSource(source: PendingPdfCanonicalSource): void {
  enforceCapacity();
  const key = buildPendingPdfCanonicalKey(source);
  const entry = {} as PendingPdfCanonicalEntry;
  const timer = setTimeout(() => {
    if (removeEntry(key, entry)) void destroyQuietly(source);
  }, getRegistryTtlMs());
  timer.unref?.();
  Object.assign(entry, {
    source,
    registeredAt: Date.now(),
    timer,
  });
  const queue = pendingByKey.get(key) ?? [];
  queue.push(entry);
  pendingByKey.set(key, queue);
  pendingCount += 1;
}

export function consumePendingPdfCanonicalSource(args: {
  readonly ownerUserId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly previewText: string;
}): PendingPdfCanonicalSource | undefined {
  const key = buildPendingPdfCanonicalKey(args);
  const queue = pendingByKey.get(key);
  const entry = queue?.[0];
  if (!entry) return undefined;
  removeEntry(key, entry);
  return entry.source;
}

export async function clearPendingPdfCanonicalSourcesForTests(): Promise<void> {
  const entries = [...pendingByKey.entries()].flatMap(([key, queue]) =>
    queue.map((entry) => ({ key, entry })),
  );
  for (const { key, entry } of entries) {
    if (removeEntry(key, entry)) await destroyQuietly(entry.source);
  }
}

export function getPendingPdfCanonicalSourceCountForTests(): number {
  return pendingCount;
}
