// Characterization / regression baseline (Tranche 1, Task 1.3).
// Captures the CURRENT directional validator. KNOWN-DEFECT note references Finding 29 / D-8.
import { describe, it, expect } from "vitest";
import { isValidTransition, isDownstreamOf } from "@/utils/statusFlow";

describe("statusFlow — characterization baseline (current validator)", () => {
  it("permits the canonical forward path", () => {
    expect(isValidTransition(null, "Draft", "Treasurer")).toBe(true);
    expect(isValidTransition("Draft", "Submitted", "Treasurer")).toBe(true);
    expect(isValidTransition("Submitted", "AuditApproved", "Auditor")).toBe(true);
    expect(isValidTransition("AuditApproved", "SubmittedToOverseer", "Chairperson")).toBe(true);
    expect(isValidTransition("SubmittedToOverseer", "SubmittedToHO", "Overseer")).toBe(true);
    expect(isValidTransition("SubmittedToHO", "HOReviewed", "HO")).toBe(true);
  });

  it("rejects an invalid jump and detects downstream", () => {
    expect(isValidTransition("Draft", "AuditApproved", "Auditor")).toBe(false);
    expect(isDownstreamOf("SubmittedToOverseer", "AuditApproved")).toBe(true);
    expect(isDownstreamOf("Draft", "Submitted")).toBe(false);
  });

  it("only HO may perform CORRECTION / UNLOCK", () => {
    expect(isValidTransition("HOReviewed", "Draft", "HO", "UNLOCK")).toBe(true);
    expect(isValidTransition("HOReviewed", "Draft", "Chairperson", "UNLOCK")).toBe(false);
  });

  // KNOWN DEFECT (Finding 29 / D-8): deployed period_status enum =
  // {Draft, Submitted, AuditApproved, SubmittedToOverseer, Rejected, SubmittedToHO, HOReviewed}.
  // statusFlow.ts matches it, but src/review/OverseerReview.tsx writes "OverseerApproved" /
  // "OverseerRejected" which are NOT in the enum/validator and error at the DB. Fix under Task 3.
});
