// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUIDE CONTENT (PRIORITY 3 — "What you can do here")
// Pure, dependency-light content map used by the dismissible post-sign-in guide card
// and the public landing page. Keyed by Role (display content, NOT an authorization
// gate — all real access decisions stay in permissions.ts / RLS, steering #1). Every
// capture/audit-touching role carries the explicit "cannot sign your own preparation"
// note so the two-person-independence rule is visible wherever the guide is shown.
// ─────────────────────────────────────────────────────────────────────────────

import type { Role } from "@/lib/types";

export interface RoleGuide {
  role: Role;
  /** One-line "who you are here". */
  summary: string;
  /** What this role can do, plain and specific. */
  bullets: string[];
  /** Independence / sign-off note shown with emphasis when present. */
  note?: string;
}

// The canonical capture -> submit -> audit flow, shown on the guide and the landing.
export const CASHBOOK_FLOW: readonly string[] = [
  "Capture the week's cashbook on the device (works offline).",
  "Complete capture and submit the frozen revision for audit.",
  "Two eligible auditors sign off the same revision before it is approved.",
] as const;

const GUIDES: Record<Role, RoleGuide> = {
  Treasurer: {
    role: "Treasurer",
    summary: "You keep the congregation's weekly cashbook.",
    bullets: [
      "Capture members, officers, burial and expense lines, with proof of banking.",
      "Save locally and keep working offline; transfers queue and retry on their own.",
      "Complete capture and submit the revision for audit — you are the default sign-off.",
      "Declared-outstanding proofs can still be finished after you submit.",
    ],
    note: "You cannot approve a capture you prepared — audit sign-off is done by independent auditors.",
  },
  Chairperson: {
    role: "Chairperson",
    summary: "You step in only when the Treasurer cannot act.",
    bullets: [
      "Capture and submit as a recorded exception when the Treasurer is unavailable (e.g. ill).",
      "Submit the completed month to the Overseer as the fallback submitter.",
      "Act as the second audit sign-off (acting auditor) with a recorded reason.",
    ],
    note: "You may give the second sign-off only if you had no part in preparing, editing or submitting that capture. Acting as Treasurer disqualifies you from signing it.",
  },
  Auditor: {
    role: "Auditor",
    summary: "You review submitted captures and sign them off.",
    bullets: [
      "Open a submitted revision once the server confirms its evidence and balance.",
      "Sign off the exact revision; two eligible sign-offs are needed to approve it.",
      "A new revision after a rejection needs fresh sign-offs.",
    ],
    note: "You cannot sign off a capture you prepared, and the same person cannot sign it twice.",
  },
  Elder: {
    role: "Elder",
    summary: "You oversee your congregation(s) and keep the month moving.",
    bullets: [
      "See why a capture is pending and coordinate the missing reviewer.",
      "You are the first point of contact when two sign-offs cannot be obtained.",
      "Submit the completed month to the Overseer.",
    ],
    note: "Elder oversight is not an audit signature — captures stay pending until two valid sign-offs are obtained.",
  },
  Overseer: {
    role: "Overseer",
    summary: "You review months submitted by congregations in your scope.",
    bullets: [
      "Approve or reject months submitted to you.",
      "Submit approved months on to Head Office.",
      "Step in only when an Elder cannot resolve a pending capture.",
    ],
  },
  Apostle: {
    role: "Apostle",
    summary: "You have a consolidated view across the hierarchy.",
    bullets: [
      "Review congregational and monthly status across your scope.",
      "Export consolidated reports.",
    ],
  },
  HO: {
    role: "HO",
    summary: "You administer Head Office, limited to your assigned districts.",
    bullets: [
      "Manage users, congregations, officers and the hierarchy.",
      "Run bulk imports and review audit logs.",
      "Give the final review on months submitted to Head Office.",
    ],
    note: "You only ever see the districts assigned to you.",
  },
  Secretary: {
    role: "Secretary",
    summary: "You see congregational finance totals.",
    bullets: [
      "View consolidated totals for the congregation.",
      "Export the reports available to you.",
    ],
    note: "You see totals only — line-item detail and proof images are not shown.",
  },
};

/** The guide content for a role (display content; no authorization decision here). */
export function getRoleGuide(role: Role): RoleGuide {
  return GUIDES[role];
}
