// ─────────────────────────────────────────────────────────────────────────────
// SERVICE_STATUS_FLOW — directional transition validator (Req 14.4, 14.5, 14.7)
// Realigned (A8) to the REAL cashbook_period.status 7-value vocabulary:
//   Draft -> Submitted -> AuditApproved -> SubmittedToOverseer -> SubmittedToHO
//        -> HOReviewed, with a single `Rejected` state (returns to Draft).
// Only HO may raise corrections / unlock a month.
// Pure logic — no I/O — so it is directly unit/property testable (design Property 4, 11).
// NOTE: not imported by the Sync_Engine (which keeps its own PeriodStatus rank over the
// Dexie local vocabulary); realigning it here changes no sync behaviour.
// ─────────────────────────────────────────────────────────────────────────────

import type { Role, ServiceStatus } from "@/lib/types";

/** Permitted successors for each status. */
const SUCCESSORS: Record<ServiceStatus, ServiceStatus[]> = {
  Draft: ["Submitted"],
  Submitted: ["AuditApproved", "Rejected"], // audit approves or rejects
  AuditApproved: ["SubmittedToOverseer"],
  SubmittedToOverseer: ["SubmittedToHO", "Rejected"], // overseer approves or rejects
  SubmittedToHO: ["HOReviewed", "Rejected"], // HO reviews or rejects
  HOReviewed: [],
  Rejected: ["Draft"], // rejected work returns to draft for correction
};

/** Actions that only HO may perform (corrections / unlock). */
export type PrivilegedAction = "CORRECTION" | "UNLOCK";

/**
 * Validate a status transition.
 * - The initial capture (null -> Draft) is always permitted.
 * - Otherwise `to` must be a permitted successor of `from`.
 * - A privileged action (CORRECTION/UNLOCK) is permitted only when actorRole is HO.
 */
export function isValidTransition(
  from: ServiceStatus | null,
  to: ServiceStatus,
  actorRole: Role,
  action?: PrivilegedAction
): boolean {
  if (action === "CORRECTION" || action === "UNLOCK") {
    return actorRole === "HO";
  }
  if (from === null) {
    return to === "Draft";
  }
  return SUCCESSORS[from]?.includes(to) ?? false;
}

/**
 * True if `candidate` is strictly downstream of `reference` in the flow — i.e. the
 * server has advanced past the locally captured status. Used for conflict detection
 * (Req 14.6): if the server status is further along, the local write is stale.
 */
export function isDownstreamOf(candidate: ServiceStatus, reference: ServiceStatus): boolean {
  const order = statusRank(candidate) - statusRank(reference);
  return order > 0;
}

/** Linear rank used only for "has the server advanced beyond me" comparisons. */
export function statusRank(status: ServiceStatus): number {
  const ORDER: ServiceStatus[] = [
    "Draft",
    "Submitted",
    "AuditApproved",
    "SubmittedToOverseer",
    "SubmittedToHO",
    "HOReviewed",
  ];
  // The single Rejected state returns to Draft; rank it alongside Draft.
  if (status === "Rejected") return ORDER.indexOf("Draft");
  return ORDER.indexOf(status);
}
