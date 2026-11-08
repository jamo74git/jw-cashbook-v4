// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE_CAPTURE — freeze the submission snapshot + the Required_Manifest, and
// separate the three independent conditions (PRIORITY 1; design D1, §2.2.1, §6.6):
//   • Business_State  — `Submitted` (the period is locked for edit)
//   • Review_Ready    — every required proof is present AND the revision balances
//   • Sign-off        — Treasurer by DEFAULT; anyone else is a recorded EXCEPTION
//
// `Submitted` is NOT the same as "Ready for Audit": a submission whose declared
// proofs are still outstanding is locked but NOT approvable. Audit approval opens
// only once evidence + balance are verified for the EXACT frozen revision. The
// AUTHORITATIVE Review_Ready is server-computed from `cashbook_submission_manifest`
// (schema-gated, NOT applied here); this module is the pure local mirror used by the
// capture UI and the online audit gate. All functions are pure and dependency-light.
// ─────────────────────────────────────────────────────────────────────────────

import type { Role } from "@/lib/types";
import { hasPermission } from "@/lib/permissions";
import { isBalanced, type CaptureItem, type ItemType } from "@/lib/captureTotals";

// Item types that require supporting evidence (mirrors CashbookForm `needsProof` plus
// CashBanked cash, which is evidenced by the shared deposit slip).
const PROOF_REQUIRED_TYPES: ItemType[] = ["EFT", "DirectDebit", "Burial", "Expense", "CashBanked"];
const EXEMPT_TYPES: ItemType[] = ["Cash", "CashPending"];

export function proofRequiredFor(itemType: string): boolean {
  return (PROOF_REQUIRED_TYPES as string[]).includes(itemType);
}

// ─── Required_Manifest (frozen proof list belonging to a revision) ───────────
export type ManifestProofStatus = "declared-present" | "declared-outstanding" | "exempt";

export interface ManifestProofEntry {
  lineLocalId: string;
  itemType: string;
  proofObjectKey: string | null;
  proofHash: string | null;
  status: ManifestProofStatus;
}

export interface RequiredManifest {
  /** Monotonic revision this manifest is frozen against; a new submission = a fresh revision. */
  revision: number;
  frozenAt: string;
  balanced: boolean;
  depositSlipKey: string | null;
  proofs: ManifestProofEntry[];
}

export interface ManifestLineInput {
  localId: string;
  section: string;
  item_type: string;
  amount: number;
  proofObjectKey?: string | null;
  proofHash?: string | null;
  proof_status?: string | null;
  proofBlob?: unknown; // presence only; Blob not imported here
}

function proofPresent(line: ManifestLineInput): boolean {
  return (
    !!line.proofObjectKey ||
    !!line.proofBlob ||
    line.proof_status === "Deposited" ||
    line.proof_status === "Pending"
  );
}

/**
 * Compute the immutable Required_Manifest for the CURRENT line items at freeze time.
 * Exempt cash is recorded as `exempt`; a required proof that is present is
 * `declared-present`; a required proof not yet captured is `declared-outstanding`
 * (legitimately allowed to finish AFTER submission).
 */
export function computeRequiredManifest(
  lines: ManifestLineInput[],
  opts: { revision: number; frozenAt: string; depositSlipKey?: string | null }
): RequiredManifest {
  const proofs: ManifestProofEntry[] = lines.map((line) => {
    let status: ManifestProofStatus;
    if ((EXEMPT_TYPES as string[]).includes(line.item_type)) {
      status = "exempt";
    } else if (proofRequiredFor(line.item_type)) {
      status = proofPresent(line) ? "declared-present" : "declared-outstanding";
    } else {
      status = "exempt";
    }
    return {
      lineLocalId: line.localId,
      itemType: line.item_type,
      proofObjectKey: line.proofObjectKey ?? null,
      proofHash: line.proofHash ?? null,
      status,
    };
  });
  const ci: CaptureItem[] = lines.map((l) => ({
    section: l.section as CaptureItem["section"],
    item_type: l.item_type as ItemType,
    amount: Number(l.amount) || 0,
    proof_status: null,
    item_count: null,
  }));
  return {
    revision: opts.revision,
    frozenAt: opts.frozenAt,
    balanced: isBalanced(ci),
    depositSlipKey: opts.depositSlipKey ?? null,
    proofs,
  };
}

/** Proofs still owed on a frozen manifest (declared-outstanding at freeze). */
export function outstandingProofs(manifest: RequiredManifest): ManifestProofEntry[] {
  return manifest.proofs.filter((p) => p.status === "declared-outstanding");
}

// ─── Sign-off resolution (Treasurer default; everyone else = recorded exception) ──
export type SignOffReason = "default" | "exception" | "ineligible";

export interface SignOffResolution {
  eligible: boolean;
  /** The role the submission is signed off AS — always Treasurer for capture. */
  signOffRole: Role | null;
  /** True when a reason MUST be recorded (a non-Treasurer is signing, e.g. Treasurer ill). */
  requiresException: boolean;
  reason: SignOffReason;
}

/**
 * Who may complete + sign off a capture. Eligibility is routed through the permission
 * matrix (`capture.submit`), never a hardcoded role string. The Treasurer is the
 * DEFAULT signer; any other eligible role (Chairperson, Elder override) is an EXCEPTION
 * that requires a recorded reason. A role without `capture.submit` is ineligible.
 */
export function resolveSignOff(role: Role): SignOffResolution {
  if (!hasPermission(role, "capture.submit")) {
    return { eligible: false, signOffRole: null, requiresException: false, reason: "ineligible" };
  }
  if (role === "Treasurer") {
    return { eligible: true, signOffRole: "Treasurer", requiresException: false, reason: "default" };
  }
  return { eligible: true, signOffRole: "Treasurer", requiresException: true, reason: "exception" };
}

/** Human label for the recorded sign-off (e.g. the audit "acting auditor" style). */
export function signOffLabel(res: Pick<SignOffResolution, "requiresException">, actualRole: Role): string {
  return res.requiresException ? `${actualRole} (acting Treasurer — exception)` : "Treasurer";
}

// ─── Review_Ready (local mirror of the server-computed condition) ────────────
export interface ReviewEvidenceLine {
  id: string;
  section: string;
  item_type: string;
  amount: number;
}

export interface ReviewReadiness {
  ready: boolean;
  balanced: boolean;
  missingEvidenceLineIds: string[];
}

/**
 * Compute whether a submitted revision is Review_Ready from server-visible rows:
 * every proof-required line has an attachment AND the revision balances. This mirrors
 * the server condition for the UI gate; the server's own computation over
 * `cashbook_submission_manifest` is AUTHORITATIVE (flagged for hosted testing).
 */
export function computeReviewReadiness(
  lines: ReviewEvidenceLine[],
  attachedLineIds: Iterable<string>
): ReviewReadiness {
  const attached = new Set(attachedLineIds);
  const missingEvidenceLineIds = lines
    .filter((l) => proofRequiredFor(l.item_type) && !attached.has(l.id))
    .map((l) => l.id);
  const ci: CaptureItem[] = lines.map((l) => ({
    section: l.section as CaptureItem["section"],
    item_type: l.item_type as ItemType,
    amount: Number(l.amount) || 0,
    proof_status: null,
    item_count: null,
  }));
  const balanced = isBalanced(ci);
  return {
    ready: balanced && missingEvidenceLineIds.length === 0,
    balanced,
    missingEvidenceLineIds,
  };
}
