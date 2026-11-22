// Review_Ready coverage — local mirror of the server cashbook_review_ready rule with the
// proof_mandatory gate + banked-cash deposit-slip coverage (design §4.4, test plan D).
import { describe, it, expect } from "vitest";
import { computeReviewReadiness, type ReviewEvidenceLine } from "@/lib/completeCapture";

// A balanced period: 100 cash income banked as CashBanked (income === banked + expenses).
const cashBankedBalanced: ReviewEvidenceLine[] = [
  { id: "cash", section: "Members", item_type: "CashBanked", amount: 100 },
];
// A balanced non-cash period: 100 EFT income banked.
const eftBalanced: ReviewEvidenceLine[] = [
  { id: "eft", section: "Members", item_type: "EFT", amount: 100 },
];

describe("computeReviewReadiness — proof_mandatory gate + cash coverage", () => {
  it("11. proof_mandatory=false, cash present, no slip => ready (balanced-only)", () => {
    const r = computeReviewReadiness(cashBankedBalanced, [], {
      proofMandatory: false,
      cashPresent: true,
      cashCovered: false,
    });
    expect(r.balanced).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.cashCoverageMissing).toBe(false);
  });

  it("12. proof_mandatory=true, cash present, covering slip present => ready", () => {
    const r = computeReviewReadiness(cashBankedBalanced, [], {
      proofMandatory: true,
      cashPresent: true,
      cashCovered: true,
    });
    expect(r.ready).toBe(true);
    expect(r.cashCoverageMissing).toBe(false);
  });

  it("13. proof_mandatory=true, cash present, no covering slip => NOT ready", () => {
    const r = computeReviewReadiness(cashBankedBalanced, [], {
      proofMandatory: true,
      cashPresent: true,
      cashCovered: false,
    });
    expect(r.balanced).toBe(true);
    expect(r.cashCoverageMissing).toBe(true);
    expect(r.ready).toBe(false);
  });

  it("14. proof_mandatory=true, no cash: ready/not-ready per the non-cash per-line rule", () => {
    // non-cash proof present => ready
    const withEvidence = computeReviewReadiness(eftBalanced, ["eft"], {
      proofMandatory: true,
      cashPresent: false,
    });
    expect(withEvidence.ready).toBe(true);
    // non-cash proof absent => not ready
    const noEvidence = computeReviewReadiness(eftBalanced, [], {
      proofMandatory: true,
      cashPresent: false,
    });
    expect(noEvidence.ready).toBe(false);
    expect(noEvidence.missingEvidenceLineIds).toContain("eft");
  });

  it("15. combined slip covering AM+PM: each cash-bearing period reads ready when covered", () => {
    // The combined slip records a coverage row for BOTH periods, so each period passes
    // cashCovered=true independently.
    const amReady = computeReviewReadiness(cashBankedBalanced, [], {
      proofMandatory: true,
      cashPresent: true,
      cashCovered: true,
    });
    const pmReady = computeReviewReadiness(cashBankedBalanced, [], {
      proofMandatory: true,
      cashPresent: true,
      cashCovered: true,
    });
    expect(amReady.ready).toBe(true);
    expect(pmReady.ready).toBe(true);
  });

  it("mandatory cash period that does not balance is never ready regardless of coverage", () => {
    const pending: ReviewEvidenceLine[] = [{ id: "cash", section: "Members", item_type: "Cash", amount: 100 }];
    const r = computeReviewReadiness(pending, [], { proofMandatory: true, cashPresent: true, cashCovered: true });
    expect(r.balanced).toBe(false);
    expect(r.ready).toBe(false);
  });
});
