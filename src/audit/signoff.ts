// ─────────────────────────────────────────────────────────────────────────────
// TWO-PERSON AUDIT SIGN-OFF — pure eligibility / involvement / fresh-revision logic
// (PRIORITY 2). Extends (does NOT replace) the single `cashbook_review_decision`
// authority: a reviewed revision needs TWO accepted sign-offs on the SAME submitted
// revision, at least one from a real Auditor; the transition to AuditApproved is driven
// ONLY by the completing (second) valid sign-off.
//
// These functions are PURE and dependency-light so they can be unit-tested without a
// backend. They are the client mirror of the server rules; the AUTHORITATIVE enforcement
// (no self-approval, no same person twice, actual-involvement check, fresh-revision,
// atomic completing transition + trigger bypass guard) lives server-side in the authored-
// but-NOT-applied migration and must be proven with authenticated/hosted testing.
//
// Rules routed through the permission matrix (no role-string checks, steering #1):
//   • primary signer  — `audit.approve` === "A"  (Auditor)
//   • acting signer    — `audit.acting_signoff` === "O"  (Chairperson only; Elder excluded)
// ─────────────────────────────────────────────────────────────────────────────

import type { Role, SignoffPermCode } from "@/lib/types";
import { getPermission } from "@/lib/permissions";

export type SignoffSlot = 1 | 2;

// `audit_log` action types that put a user in a period's INVOLVEMENT set. Independence
// is derived from ACTUAL participation (prepare / submit / role-switch), not role alone.
export const INVOLVEMENT_ACTIONS = [
  "CAPTURE",
  "SUBMIT",
  "ACTING_AS_TREASURER",
  "SELF_REVIEW_EXCEPTION",
] as const;

export type SignoffAttemptError =
  | "signer_role_not_eligible" // role is neither Auditor (A) nor Chairperson acting (O)
  | "signer_involved" // took part in preparing/editing/submitting this capture
  | "already_signed" // this person already has an accepted sign-off on this revision
  | "reason_required" // acting-auditor sign-off without a recorded reason
  | "acting_not_second_slot" // acting-auditor cannot be the first/sole signer
  | "needs_auditor_in_pair" // a valid pair must contain one real Auditor-"A"
  | "not_review_ready" // completing sign-off attempted before evidence + balance verified
  | "rejected_stale"; // revision/generation advanced since the review was opened

// One accepted sign-off bound to a specific reviewed revision + capture generation.
export interface SignoffRecord {
  actorUserId: string;
  permCode: SignoffPermCode; // 'A' real Auditor | 'O' Chairperson acting
  actingAsAuditor: boolean;
  actingReason: string | null;
  captureGeneration: number;
  reviewedRevision: number;
  slot: SignoffSlot;
}

// ─── Eligibility (matrix-routed) ─────────────────────────────────────────────

export type SignoffRoleKind = "primary" | "acting";

/**
 * Resolve whether a role may sign off and in which capacity, via the permission matrix:
 * Auditor ("A") is the PRIMARY signer; Chairperson ("O" on `audit.acting_signoff`) is the
 * ACTING signer. Every other role (including Elder, which holds "O" on `audit.approve` for
 * its separate drill-in override) returns null — not an eligible two-person signatory.
 */
export function signoffRoleKind(role: Role): SignoffRoleKind | null {
  if (getPermission(role, "audit.approve") === "A") return "primary";
  if (getPermission(role, "audit.acting_signoff") === "O") return "acting";
  return null;
}

/** Matrix code a role would carry on a sign-off, or null if ineligible. */
export function signoffPermCode(role: Role): SignoffPermCode | null {
  const kind = signoffRoleKind(role);
  if (kind === "primary") return "A";
  if (kind === "acting") return "O";
  return null;
}

// ─── Involvement (independence from preparation, not just role) ──────────────

/**
 * Build the INVOLVEMENT set for a period: the submitter plus every user who logged a
 * CAPTURE / SUBMIT / ACTING_AS_TREASURER / SELF_REVIEW_EXCEPTION against it. A signer in
 * this set is disqualified. This catches BOTH no-self-approval (the submitter is in the
 * set) AND the role-switch block: a Chairperson who captured as Treasurer logged
 * ACTING_AS_TREASURER, so they cannot sign by switching back to Chairperson.
 */
export function involvementSet(params: {
  submittedBy: string | null;
  participationLog: { userId: string; actionType: string }[];
}): Set<string> {
  const set = new Set<string>();
  if (params.submittedBy) set.add(params.submittedBy);
  for (const row of params.participationLog) {
    if ((INVOLVEMENT_ACTIONS as readonly string[]).includes(row.actionType)) {
      set.add(row.userId);
    }
  }
  return set;
}

export function isSignerIndependent(userId: string, involvement: Set<string>): boolean {
  return !involvement.has(userId);
}

// ─── Fresh-revision binding + pair validity ──────────────────────────────────

/**
 * Keep only the accepted sign-offs bound to the CURRENT generation + revision. Sign-offs
 * for a superseded revision (re-submission) or generation (HO reopen) do NOT count toward
 * the new one — fresh sign-offs are required — and are never deleted (history preserved).
 */
export function signoffsForRevision(
  rows: SignoffRecord[],
  captureGeneration: number,
  reviewedRevision: number
): SignoffRecord[] {
  return rows.filter(
    (r) => r.captureGeneration === captureGeneration && r.reviewedRevision === reviewedRevision
  );
}

/** A valid closing pair must contain at least one real Auditor-"A" sign-off. */
export function pairHasAuditor(rows: Pick<SignoffRecord, "permCode">[]): boolean {
  return rows.some((r) => r.permCode === "A");
}

// ─── The sign-off attempt evaluation (the heart of the rule) ─────────────────

export interface SignoffAttempt {
  actor: { userId: string; role: Role };
  // Period revision coordinates the SERVER currently holds.
  period: { captureGeneration: number; serverRevision: number };
  // The revision the client believes it is signing (fresh-revision guard).
  reviewedRevision: number;
  captureGeneration: number;
  // All accepted sign-off rows for the period (any revision; filtered internally).
  existingSignoffs: SignoffRecord[];
  // Users who prepared/edited/submitted this capture (no self-approval / role switch).
  involvement: Set<string>;
  // Evidence + balance verified for THIS revision (gates the completing sign-off only).
  reviewReady: boolean;
  // Recorded reason — mandatory for a Chairperson acting-auditor sign-off.
  actingReason?: string | null;
}

export interface SignoffEvaluation {
  ok: boolean;
  error?: SignoffAttemptError;
  permCode?: SignoffPermCode;
  slot?: SignoffSlot;
  acting?: boolean;
  /**
   * True only when this valid sign-off is the completing (second) one AND the revision is
   * Review_Ready — i.e. recording this sign-off and the AuditApproved transition succeed or
   * fail TOGETHER. willComplete is never true unless the sign-off itself is accepted.
   */
  willComplete?: boolean;
  signoffCountAfter?: number;
}

/**
 * Evaluate a single sign-off attempt against all the two-person rules, in fail-closed
 * order. Returns the slot the sign-off would occupy and whether it completes the approval.
 * Mirrors the server RPC's accept/reject decision for the UI; the server is authoritative.
 */
export function evaluateSignoffAttempt(attempt: SignoffAttempt): SignoffEvaluation {
  // 1. Fresh-revision binding: the review must be for the revision the server still holds.
  if (
    attempt.reviewedRevision !== attempt.period.serverRevision ||
    attempt.captureGeneration !== attempt.period.captureGeneration
  ) {
    return { ok: false, error: "rejected_stale" };
  }

  // 2. Eligibility (matrix-routed): Auditor primary or Chairperson acting only.
  const kind = signoffRoleKind(attempt.actor.role);
  if (!kind) return { ok: false, error: "signer_role_not_eligible" };

  // 3. Independence: no self-approval, and no one who prepared/edited/submitted.
  if (!isSignerIndependent(attempt.actor.userId, attempt.involvement)) {
    return { ok: false, error: "signer_involved" };
  }

  const current = signoffsForRevision(
    attempt.existingSignoffs,
    attempt.captureGeneration,
    attempt.reviewedRevision
  );

  // A completed pair already exists — a further attempt is stale (approval bumps revision).
  if (current.length >= 2) return { ok: false, error: "rejected_stale" };

  // 4. Same person cannot sign twice on the same revision.
  if (current.some((r) => r.actorUserId === attempt.actor.userId)) {
    return { ok: false, error: "already_signed" };
  }

  const slot: SignoffSlot = current.length === 0 ? 1 : 2;
  const permCode: SignoffPermCode = kind === "primary" ? "A" : "O";
  const acting = kind === "acting";

  // 5. Acting-auditor (Chairperson) rules: recorded reason + completing slot only.
  if (acting) {
    if (!attempt.actingReason || attempt.actingReason.trim() === "") {
      return { ok: false, error: "reason_required" };
    }
    if (slot !== 2) return { ok: false, error: "acting_not_second_slot" };
  }

  // 6. Completing (second) sign-off: valid pair must include an Auditor, and the revision
  //    must be Review_Ready. These bind the sign-off and the transition together.
  let willComplete = false;
  if (slot === 2) {
    const prospectivePair = [...current, { permCode }];
    if (!pairHasAuditor(prospectivePair)) {
      return { ok: false, error: "needs_auditor_in_pair" };
    }
    if (!attempt.reviewReady) return { ok: false, error: "not_review_ready" };
    willComplete = true;
  }

  return {
    ok: true,
    permCode,
    slot,
    acting,
    willComplete,
    signoffCountAfter: current.length + 1,
  };
}

// ─── Elder referral gap path (derived, not stored) ───────────────────────────

/**
 * A submitted revision that is Review_Ready but has exactly ONE accepted sign-off is
 * PENDING-needs-second: it stays `Submitted` (no one-signature closure) and is surfaced to
 * the congregation's Elder to coordinate the missing independent reviewer. Derived, never a
 * stored status — consistent with leaving captures pending for the pilot.
 */
export function pendingNeedsSecond(params: {
  status: string;
  reviewReady: boolean;
  acceptedSignoffsThisRevision: number;
}): boolean {
  return (
    params.status === "Submitted" &&
    params.reviewReady &&
    params.acceptedSignoffsThisRevision === 1
  );
}

// ─── UI labels ───────────────────────────────────────────────────────────────

/** Human label for a recorded sign-off, e.g. "Second sign-off: Chairperson (acting auditor)". */
export function signoffLabel(row: Pick<SignoffRecord, "slot" | "permCode">, signerName?: string): string {
  const who = row.permCode === "A" ? "Auditor" : "Chairperson (acting auditor)";
  const suffix = signerName ? ` — ${signerName}` : "";
  return row.slot === 1 ? `Sign-off 1 of 2: ${who}${suffix}` : `Second sign-off: ${who}${suffix}`;
}
