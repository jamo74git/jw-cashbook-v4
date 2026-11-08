// ─────────────────────────────────────────────────────────────────────────────
// ACTOR ISOLATION for progressive/manual transfer (PRIORITY 1 gate).
// Pure, dependency-free helpers so the Sync_Engine only ever dispatches a given
// actor's OWN queued work. On a shared device a build must NEVER drain another
// saved user's queue under the wrong authenticated identity (design D2 / §8, R28).
//
// The server (RLS + the authenticated JWT) remains the AUTHORITY; these client-side
// filters are a FAIL-CLOSED pre-dispatch gate, not a substitute for server enforcement.
// Whether RLS actually refuses a second user's writes under the wrong JWT can only be
// proven with authenticated/hosted testing (reported, not asserted here).
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalPeriod } from "@/db/schema";

export interface QueueScope {
  /** Restrict to one congregation (existing manual-sync scoping; backward compatible). */
  congregationId?: string;
  /**
   * Restrict to the work captured by THIS authenticated actor. When provided, only
   * periods whose `capturedByUserId` matches are eligible for dispatch. This filter
   * MUST be supplied before any AUTOMATIC/progressive dispatch is enabled so a second
   * user's pending work in the same congregation is never sent under the wrong JWT.
   */
  actorUserId?: string;
}

/**
 * Fail-closed authorization: a queued period may be replayed ONLY under the identity
 * that captured it. A missing/empty actor id authorizes nothing.
 */
export function isReplayAuthorized(
  period: Pick<LocalPeriod, "capturedByUserId">,
  actorUserId: string | null | undefined
): boolean {
  if (!actorUserId) return false;
  return period.capturedByUserId === actorUserId;
}

/**
 * Filter a queue to the work the given actor/congregation may dispatch.
 * - `congregationId` filtering is unchanged when `actorUserId` is absent (backward compatible).
 * - When `actorUserId` is present (even as an empty string), cross-actor work is excluded;
 *   an empty/unknown actor yields an EMPTY queue (fail-closed shared-device isolation).
 */
export function filterQueueForActor<
  T extends Pick<LocalPeriod, "congregationId" | "capturedByUserId">
>(periods: T[], scope: QueueScope = {}): T[] {
  const actorScoped = scope.actorUserId !== undefined;
  return periods.filter((p) => {
    if (scope.congregationId && p.congregationId !== scope.congregationId) return false;
    if (actorScoped && !isReplayAuthorized(p, scope.actorUserId)) return false;
    return true;
  });
}
