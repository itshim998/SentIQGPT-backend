import { detectExplicitMemoryWriteIntent } from "../orchestrator/queryClassifier";

export interface ExistingMemoryCandidate {
  readonly type: string;
  readonly summary: string;
  readonly scope?: "global" | "chat";
}

export function validateAutomaticMemoryUpdateRequest(originalUserRequest: string): string {
  const normalized = originalUserRequest.trim();
  if (!detectExplicitMemoryWriteIntent(normalized)) {
    throw new Error("Explicit memory intent is required.");
  }
  return normalized;
}

export function isDuplicateMemoryCandidate(
  existingMemories: readonly ExistingMemoryCandidate[],
  candidate: { type?: string; summary?: string },
  requestedScope?: "global" | "chat",
): boolean {
  const summary = candidate.summary?.trim().toLowerCase();
  if (!candidate.type || !summary) return false;
  return existingMemories.some((existing) => (
    existing.type === candidate.type
    && existing.summary.trim().toLowerCase() === summary
    && (requestedScope === "chat" ? existing.scope === "chat" : existing.scope !== "chat")
  ));
}
