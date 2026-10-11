/**
 * Obsolete guest generation recovery.
 * Guest chat generation state is strictly in-memory only and non-recoverable across process restarts.
 * No startup scan or background timer is registered.
 */
export async function recoverStaleGuestGenerations(): Promise<void> {
  // No-op: guest generation is in-memory only and performs no recovery scan.
}
