// ─────────────────────────────────────────────────────────────────────────────
// UI STATUS LABELS (MVP hardening v5, Decision 1)
// Relabel the real cashbook_period.status DB values for DISPLAY ONLY. The DB values
// (Submitted / AuditApproved) are NOT renamed; statusFlow.ts SUCCESSORS are unchanged.
//   Submitted      -> "Submitted for audit"
//   AuditApproved  -> "Closed"
// Draft / Rejected are shown as-is.
// ─────────────────────────────────────────────────────────────────────────────

import type { PeriodStatus } from "@/db/schema";

export function periodStatusLabel(status: PeriodStatus): string {
  switch (status) {
    case "Submitted":
      return "Submitted for audit";
    case "AuditApproved":
      return "Closed";
    default:
      return status; // Draft, Rejected unchanged
  }
}
